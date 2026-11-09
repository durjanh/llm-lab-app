using MedAssist.Application;
using MedAssist.Domain;
using Microsoft.Extensions.Options;

namespace MedAssist.Integrations.Foundry.PromptAgent;

/// <summary>
/// MedAssist as a Foundry prompt agent, with our own tool loop: the .NET medassist.py. The agent (model,
/// instructions, tools) is saved in Foundry by `medassist create`; this holds conversations with it.
/// </summary>
public sealed class PromptAgentEngine(IPromptAgentConversations conversations, ToolLoop loop, IAgentCatalog catalog,
                                      IOptions<FoundryOptions> foundry, FailureReporter failures) : IMedAssistEngine
{
    public const string EngineName = "prompt-agent";

    public string Name => EngineName;

    public string Model => foundry.Value.Model;

    public async Task<EngineStatus> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            var version = await catalog.LatestVersionAsync(MedAssistAgent.Name, cancellationToken);
            return version is null
                ? new EngineStatus(true, false, Model, null, "There is no MedAssist agent in the Foundry project yet. Run `medassist create`.")
                : new EngineStatus(true, true, Model, version);
        }
        catch (Exception exc) when (exc is not OperationCanceledException)
        {
            var failure = failures.Classify(exc);
            return new EngineStatus(failure.Kind != FailureKind.NotConfigured, false, null, null, failure.Message);
        }
    }

    public async Task<IEngineConversation> StartAsync(PatientSession session, IStepObserver observer,
                                                      CancellationToken cancellationToken = default)
    {
        var conversation = await conversations.StartAsync(MedAssistAgent.Name, session.PortalNote(), cancellationToken);
        return new Conversation(conversation, loop, session, observer);
    }

    private sealed class Conversation(IAgentConversation agent, ToolLoop loop, PatientSession session, IStepObserver observer)
        : IEngineConversation
    {
        public Task<TurnResult> AskAsync(string text, CancellationToken cancellationToken = default) =>
            loop.RunAsync(agent, session, text, observer, cancellationToken);

        public ValueTask DisposeAsync() => agent.DisposeAsync();
    }
}
