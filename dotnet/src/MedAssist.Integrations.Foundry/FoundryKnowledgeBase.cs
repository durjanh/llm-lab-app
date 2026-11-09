using MedAssist.Application;
using OpenAI.Files;
using OpenAI.VectorStores;

namespace MedAssist.Integrations.Foundry;

/// <summary>
/// The practice documents' vector store in Foundry (Adapter for <see cref="IKnowledgeBase"/>). Its name,
/// medassist-knowledge, is the one the Python version uses, so both search the same documents.
/// </summary>
public sealed class FoundryKnowledgeBase(IFoundryProject project) : IKnowledgeBase
{
    public const string StoreName = "medassist-knowledge";

    private static readonly TimeSpan IndexingWait = TimeSpan.FromSeconds(60);

    private VectorStoreClient Stores => project.Client.ProjectOpenAIClient.GetVectorStoreClient();

    private OpenAIFileClient Files => project.Client.ProjectOpenAIClient.GetOpenAIFileClient();

    public async Task<string?> FindStoreAsync(CancellationToken cancellationToken = default) =>
        (await NamedAsync(cancellationToken)).FirstOrDefault()?.Id;

    public async Task<KnowledgeIndex> ReplaceAsync(IReadOnlyList<KnowledgeDocument> documents, CancellationToken cancellationToken = default)
    {
        await DeleteAsync(cancellationToken);  // replace the documents each time, so edits to them take effect
        var options = new VectorStoreCreationOptions { Name = StoreName };
        foreach (var document in documents)
        {
            using var content = new MemoryStream(document.Content);
            OpenAIFile file = await Files.UploadFileAsync(content, document.FileName, FileUploadPurpose.Assistants, cancellationToken);
            options.FileIds.Add(file.Id);
        }
        VectorStore store = await Stores.CreateVectorStoreAsync(options, cancellationToken);
        var deadline = DateTime.UtcNow + IndexingWait;
        while (store.FileCounts.InProgress > 0 && DateTime.UtcNow < deadline)  // indexing takes a few seconds
        {
            await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken);
            store = await Stores.GetVectorStoreAsync(store.Id, cancellationToken);
        }
        return new KnowledgeIndex(store.Id, store.FileCounts.Completed, documents.Count);
    }

    public async Task<IReadOnlyList<string>> DeleteAsync(CancellationToken cancellationToken = default)
    {
        var deleted = new List<string>();
        foreach (var store in await NamedAsync(cancellationToken))
        {
            var fileIds = new List<string>();  // deleting the store alone leaves its files behind
            await foreach (var file in Stores.GetVectorStoreFilesAsync(store.Id, cancellationToken: cancellationToken))
            {
                fileIds.Add(file.FileId);
            }
            foreach (var id in fileIds)
            {
                await Files.DeleteFileAsync(id, cancellationToken);
            }
            await Stores.DeleteVectorStoreAsync(store.Id, cancellationToken);
            deleted.Add(store.Id);
        }
        return deleted;
    }

    private async Task<List<VectorStore>> NamedAsync(CancellationToken cancellationToken)
    {
        var stores = new List<VectorStore>();
        await foreach (var store in Stores.GetVectorStoresAsync(cancellationToken: cancellationToken))
        {
            if (store.Name == StoreName)
            {
                stores.Add(store);
            }
        }
        return stores;
    }
}
