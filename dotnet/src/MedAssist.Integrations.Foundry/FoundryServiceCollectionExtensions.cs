using Azure.Core;
using Azure.Identity;
using MedAssist.Application;
using MedAssist.Integrations.Foundry.AgentFramework;
using MedAssist.Integrations.Foundry.PromptAgent;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;

namespace MedAssist.Integrations.Foundry;

public static class FoundryServiceCollectionExtensions
{
    /// <summary>
    /// Foundry behind the service layer's ports: the knowledge base, the agent catalog, both engines, and the one
    /// the services use, chosen by MedAssist:Engine (Strategy). Signed in with DefaultAzureCredential (az login).
    /// </summary>
    public static IServiceCollection AddFoundryIntegration(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<FoundryOptions>().Bind(configuration.GetSection(FoundryOptions.Section));
        services.AddSingleton<IValidateOptions<FoundryOptions>, ValidateFoundryOptions>();
        services.TryAddSingleton<TokenCredential>(_ => new DefaultAzureCredential());
        services.TryAddSingleton<IFoundryProject, FoundryProject>();
        services.TryAddSingleton<IKnowledgeBase, FoundryKnowledgeBase>();
        services.TryAddSingleton<IAgentCatalog, FoundryAgentCatalog>();
        services.AddSingleton<IFailureClassifier, FoundryFailureClassifier>();

        services.TryAddSingleton<IPromptAgentConversations, FoundryPromptAgentConversations>();
        services.TryAddSingleton<ToolLoop>();
        services.TryAddSingleton<IAgentFrameworkClient, FoundryAgentFrameworkClient>();
        services.AddKeyedSingleton<IMedAssistEngine, PromptAgentEngine>(PromptAgentEngine.EngineName);
        services.AddKeyedSingleton<IMedAssistEngine, AgentFrameworkEngine>(AgentFrameworkEngine.EngineName);
        services.TryAddSingleton(sp => sp.GetRequiredKeyedService<IMedAssistEngine>(
            sp.GetRequiredService<IOptions<MedAssistOptions>>().Value.Engine));
        return services;
    }
}
