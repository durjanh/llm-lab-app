using MedAssist.Domain;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace MedAssist.Data;

public static class DataServiceCollectionExtensions
{
    /// <summary>The SQLite data layer: the services ask for stores by path and get SQLite ones.</summary>
    public static IServiceCollection AddMedAssistData(this IServiceCollection services)
    {
        services.TryAddSingleton<IPracticeStoreFactory, SqlitePracticeStoreFactory>();
        return services;
    }
}
