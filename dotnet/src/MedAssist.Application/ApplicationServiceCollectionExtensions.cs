using MedAssist.Domain;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;

namespace MedAssist.Application;

public static class ApplicationServiceCollectionExtensions
{
    /// <summary>
    /// The service layer and the domain it uses: options from configuration, the clinic's tools, the services the
    /// API and the CLI call, and the failure classifiers. The database and the engines are registered by their own
    /// layers (AddMedAssistData, AddFoundryEngines).
    /// </summary>
    public static IServiceCollection AddMedAssistApplication(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<MedAssistOptions>().Bind(configuration.GetSection(MedAssistOptions.Section));
        services.AddSingleton<IPostConfigureOptions<MedAssistOptions>, ResolveMedAssistPaths>();
        services.AddSingleton<IValidateOptions<MedAssistOptions>, ValidateMedAssistOptions>();
        services.AddOptions<PricingOptions>().Bind(configuration.GetSection(PricingOptions.Section));

        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton<INotifier>(NullNotifier.Instance);  // real texts run in the Python backend
        services.TryAddSingleton(_ => ClinicToolbox.Standard());  // the clinic's four tools, for both engines

        services.TryAddSingleton<ISpendTracker, SpendTracker>();
        services.TryAddSingleton<PracticeService>();
        services.TryAddSingleton<ChatService>();
        services.TryAddSingleton<ScenarioRunner>();
        services.TryAddSingleton<IKnowledgeDocuments, FolderKnowledgeDocuments>();
        services.TryAddSingleton<FailureReporter>();
        services.AddSingleton<IFailureClassifier, ServiceFailureClassifier>();
        return services;
    }
}
