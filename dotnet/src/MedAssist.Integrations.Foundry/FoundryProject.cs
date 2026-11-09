using Azure.AI.Projects;
using Azure.Core;
using Microsoft.Extensions.Options;

namespace MedAssist.Integrations.Foundry;

/// <summary>The Foundry project MedAssist runs in: the "Foundry" section of appsettings.json.</summary>
public sealed class FoundryOptions
{
    public const string Section = "Foundry";

    /// <summary>https://&lt;resource&gt;.services.ai.azure.com/api/projects/&lt;project&gt;</summary>
    public string ProjectEndpoint { get; set; } = "";

    /// <summary>The model deployment the agent uses, such as gpt-5.4-mini.</summary>
    public string Model { get; set; } = "";
}

/// <summary>Settings that cannot reach Foundry are reported the first time the options are read.</summary>
public sealed class ValidateFoundryOptions : IValidateOptions<FoundryOptions>
{
    public ValidateOptionsResult Validate(string? name, FoundryOptions options)
    {
        var failures = new List<string>();
        if (!Uri.TryCreate(options.ProjectEndpoint, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
        {
            failures.Add("Foundry:ProjectEndpoint must be the Foundry project's https address. Set it in appsettings.Local.json.");
        }
        if (options.Model.Length == 0)
        {
            failures.Add("Foundry:Model must name a model deployment. Set it in appsettings.Local.json.");
        }
        return failures.Count == 0 ? ValidateOptionsResult.Success : ValidateOptionsResult.Fail(failures);
    }
}

/// <summary>The Foundry project client, made the first time it is needed (so a command that never calls Foundry
/// never needs its settings), signed in with your Azure login: no keys.</summary>
public interface IFoundryProject
{
    AIProjectClient Client { get; }
}

public sealed class FoundryProject(IOptions<FoundryOptions> options, TokenCredential credential) : IFoundryProject
{
    private readonly Lazy<AIProjectClient> _client =
        new(() => new AIProjectClient(new Uri(options.Value.ProjectEndpoint), credential));

    public AIProjectClient Client => _client.Value;
}
