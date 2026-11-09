using MedAssist.Domain;

namespace MedAssist.Application;

/// <summary>What a prompt agent is made of: saved in Foundry as a new version of the agent.</summary>
public sealed record AgentDefinition(string Name, string Description, string Model, string Instructions, string KnowledgeStoreId,
                                     IReadOnlyList<FunctionToolSpec> FunctionTools);

public sealed record SavedAgent(string Name, string Version);

/// <summary>Where prompt agents are kept, with their versions (Foundry's agent service).</summary>
public interface IAgentCatalog
{
    Task<SavedAgent> SaveVersionAsync(AgentDefinition definition, CancellationToken cancellationToken = default);

    /// <summary>The latest version's number, or null when there is no such agent.</summary>
    Task<string?> LatestVersionAsync(string agentName, CancellationToken cancellationToken = default);

    /// <summary>Deletes the agent and all its versions. False if there was none.</summary>
    Task<bool> DeleteAsync(string agentName, CancellationToken cancellationToken = default);
}

/// <summary>One practice document, for File Search.</summary>
public sealed record KnowledgeDocument(string FileName, byte[] Content);

public sealed record KnowledgeIndex(string StoreId, int Indexed, int Total);

/// <summary>The practice documents' vector store, which File Search reads (Foundry's vector stores).</summary>
public interface IKnowledgeBase
{
    /// <summary>The store's id, or null when the documents have not been uploaded.</summary>
    Task<string?> FindStoreAsync(CancellationToken cancellationToken = default);

    /// <summary>Replaces the store and its files with these documents, and waits for them to be indexed.</summary>
    Task<KnowledgeIndex> ReplaceAsync(IReadOnlyList<KnowledgeDocument> documents, CancellationToken cancellationToken = default);

    /// <summary>Deletes the store and its files. Returns the ids of the stores deleted.</summary>
    Task<IReadOnlyList<string>> DeleteAsync(CancellationToken cancellationToken = default);
}

/// <summary>Where the practice documents are read from (a folder).</summary>
public interface IKnowledgeDocuments
{
    IReadOnlyList<KnowledgeDocument> Load();
}
