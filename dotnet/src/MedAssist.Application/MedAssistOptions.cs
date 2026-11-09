using Microsoft.Extensions.Options;

namespace MedAssist.Application;

/// <summary>
/// MedAssist's settings, from the "MedAssist" section of appsettings.json. Paths are relative to the lab's root
/// (RepoRoot), so the defaults point at the files the Python version uses: the same database and documents.
/// </summary>
public sealed class MedAssistOptions
{
    public const string Section = "MedAssist";

    /// <summary>"prompt-agent" (Foundry prompt agent, our loop) or "agent-framework" (Agent Framework runs the loop).</summary>
    public string Engine { get; set; } = "prompt-agent";

    /// <summary>The lab's root folder. Empty: the folder above dotnet/, found from where the program runs.</summary>
    public string RepoRoot { get; set; } = "";

    public string DatabasePath { get; set; } = "examples/medassist/data/medassist.db";

    /// <summary>The checked tests' own database, rebuilt for each one.</summary>
    public string TestDatabasePath { get; set; } = "examples/medassist/data/test-dotnet.db";

    public string KnowledgePath { get; set; } = "examples/medassist/knowledge";

    /// <summary>Where a reset keeps a copy of the database first: the same folder as the Python backend's copies.</summary>
    public string BackupPath { get; set; } = "generated/transcripts/databases";

    /// <summary>Open conversations the API keeps; the oldest is ended when another starts.</summary>
    public int MaxConversations { get; set; } = 20;

    /// <summary>Function-call rounds in one turn before giving up.</summary>
    public int MaxRounds { get; set; } = 6;

    /// <summary>Stops answering once this run has spent about this much, in US dollars.</summary>
    public decimal BudgetUsd { get; set; } = 1m;

    /// <summary>The patient your phone is answered as, on the Python backend's phone line (shown on the page).</summary>
    public string PhonePatient { get; set; } = "P002";
}

/// <summary>Makes MedAssist's relative paths absolute, against the lab's root.</summary>
public sealed class ResolveMedAssistPaths : IPostConfigureOptions<MedAssistOptions>
{
    public void PostConfigure(string? name, MedAssistOptions options)
    {
        var root = options.RepoRoot.Length > 0 ? options.RepoRoot : FindRepoRoot();
        options.RepoRoot = root;
        options.DatabasePath = Path.GetFullPath(options.DatabasePath, root);
        options.TestDatabasePath = Path.GetFullPath(options.TestDatabasePath, root);
        options.KnowledgePath = Path.GetFullPath(options.KnowledgePath, root);
        options.BackupPath = Path.GetFullPath(options.BackupPath, root);
    }

    /// <summary>The nearest folder above the program that holds examples/medassist; the current folder otherwise.</summary>
    public static string FindRepoRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "examples", "medassist")))
            {
                return dir.FullName;
            }
        }
        return Directory.GetCurrentDirectory();
    }
}

/// <summary>Settings that cannot work are reported when MedAssist's options are first read.</summary>
public sealed class ValidateMedAssistOptions : IValidateOptions<MedAssistOptions>
{
    public static readonly string[] Engines = ["prompt-agent", "agent-framework"];

    public ValidateOptionsResult Validate(string? name, MedAssistOptions options)
    {
        var failures = new List<string>();
        if (!Engines.Contains(options.Engine))
        {
            failures.Add($"MedAssist:Engine must be one of {string.Join(", ", Engines)}, not '{options.Engine}'.");
        }
        if (options.MaxConversations < 1 || options.MaxRounds < 1)
        {
            failures.Add("MedAssist:MaxConversations and MedAssist:MaxRounds must be at least 1.");
        }
        if (options.BudgetUsd <= 0)
        {
            failures.Add("MedAssist:BudgetUsd must be more than 0.");
        }
        return failures.Count == 0 ? ValidateOptionsResult.Success : ValidateOptionsResult.Fail(failures);
    }
}
