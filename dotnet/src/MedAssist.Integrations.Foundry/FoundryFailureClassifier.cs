using System.ClientModel;
using Azure.Identity;
using MedAssist.Application;

namespace MedAssist.Integrations.Foundry;

/// <summary>Foundry's and Azure sign-in's failures, as messages that say what to do.</summary>
public sealed class FoundryFailureClassifier : IFailureClassifier
{
    public Failure? Classify(Exception exception) => exception switch
    {
        AuthenticationFailedException => new Failure(FailureKind.Upstream, "azure_auth",
            "Azure sign-in failed. Run az login, and check your account has the Foundry User role on the Foundry resource."),
        ClientResultException { Status: 401 or 403 } => new Failure(FailureKind.Upstream, "azure_auth",
            "Foundry refused the sign-in. Run az login, and check your account has the Foundry User role on the Foundry resource."),
        ClientResultException { Status: 404 } => new Failure(FailureKind.NotConfigured, "agent_missing",
            "There is no MedAssist agent or knowledge store in the Foundry project yet. Run `medassist create`, then try again."),
        ClientResultException { Status: 429 } => new Failure(FailureKind.Busy, "rate_limited",
            "The Foundry model is busy (rate limited). Wait a moment and try again."),
        ClientResultException c => new Failure(FailureKind.Upstream, "foundry_error", $"Foundry failed ({c.Status}): {c.Message}"),
        _ => null,
    };
}
