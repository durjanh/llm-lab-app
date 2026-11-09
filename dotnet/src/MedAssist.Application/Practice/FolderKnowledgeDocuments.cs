using Microsoft.Extensions.Options;

namespace MedAssist.Application;

/// <summary>The practice documents in MedAssist:KnowledgePath (examples/medassist/knowledge): every .md file, in name order.</summary>
public sealed class FolderKnowledgeDocuments(IOptions<MedAssistOptions> options) : IKnowledgeDocuments
{
    public IReadOnlyList<KnowledgeDocument> Load()
    {
        var folder = options.Value.KnowledgePath;
        if (!Directory.Exists(folder))
        {
            throw new ServiceException(FailureKind.NotConfigured, $"No practice documents at {folder}. Check MedAssist:KnowledgePath.");
        }
        return [.. Directory.GetFiles(folder, "*.md").Order(StringComparer.Ordinal)
                            .Select(f => new KnowledgeDocument(Path.GetFileName(f), File.ReadAllBytes(f)))];
    }
}
