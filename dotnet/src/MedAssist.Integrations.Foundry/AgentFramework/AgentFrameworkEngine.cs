using Azure.AI.Projects;
using MedAssist.Application;
using MedAssist.Domain;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Foundry;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;
using OpenAI.Responses;

namespace MedAssist.Integrations.Foundry.AgentFramework;

/// <summary>Makes Agent Framework agents on the Foundry project's Responses API.</summary>
public interface IAgentFrameworkClient
{
    AIAgent CreateAgent(string name, string instructions, IList<AITool> tools);

    /// <summary>Foundry's File Search over a vector store, as an Agent Framework tool.</summary>
    AITool FileSearch(string storeId);

    /// <summary>Foundry's Code Interpreter, as an Agent Framework tool.</summary>
    AITool CodeInterpreter();
}

public sealed class FoundryAgentFrameworkClient(IFoundryProject project, IOptions<FoundryOptions> foundry, IOptions<MedAssistOptions> options)
    : IAgentFrameworkClient
{
    public AIAgent CreateAgent(string name, string instructions, IList<AITool> tools)
    {
        var agent = project.Client.AsAIAgent(model: foundry.Value.Model, instructions: instructions, name: name,
                                             description: MedAssistAgent.Description, tools: tools);
        if (agent.GetService<FunctionInvokingChatClient>() is { } loop)
        {
            loop.MaximumIterationsPerRequest = options.Value.MaxRounds;  // the prompt-agent engine's limit
        }
        return agent;
    }

    public AITool FileSearch(string storeId) => FoundryAITool.CreateFileSearchTool([storeId]);

    public AITool CodeInterpreter() => FoundryAITool.CreateCodeInterpreterTool(
        new CodeInterpreterToolContainer(CodeInterpreterToolContainerConfiguration.CreateAutomaticContainerConfiguration([])));
}

/// <summary>
/// MedAssist on Microsoft Agent Framework: the .NET medassist_af.py. The agent is defined in code, with the same
/// instructions and tools as the prompt agent, and the framework runs the tool loop. The rules do not move: they
/// are in the clinic's tools, so they hold whichever loop calls them.
/// </summary>
public sealed class AgentFrameworkEngine(IAgentFrameworkClient client, IKnowledgeBase knowledge, ClinicToolbox toolbox,
                                         IOptions<FoundryOptions> foundry, FailureReporter failures) : IMedAssistEngine
{
    public const string EngineName = "agent-framework";

    public string Name => EngineName;

    public string Model => foundry.Value.Model;

    public async Task<EngineStatus> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            return await knowledge.FindStoreAsync(cancellationToken) is null
                ? new EngineStatus(true, false, Model, null, "No practice documents in Foundry yet. Run `medassist create`.")
                : new EngineStatus(true, true, Model, "defined in code");
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
        var storeId = await knowledge.FindStoreAsync(cancellationToken)
                      ?? throw new ServiceException(FailureKind.NotConfigured, "No practice documents in Foundry yet. Run `medassist create`.");
        var conversation = new Conversation(observer);
        List<AITool> tools =
        [
            client.FileSearch(storeId),
            client.CodeInterpreter(),
            .. toolbox.Specs.Select(spec => (AITool)new ClinicFunction(spec, toolbox, session, conversation.OnFunctionStep)),
        ];
        // The prompt agent gets the date and the signed-in patient as a developer message; here they join the instructions.
        var agent = client.CreateAgent(MedAssistAgent.Name, $"{MedAssistAgent.Instructions}\n\n{session.PortalNote()}", tools);
        await conversation.StartAsync(agent, cancellationToken);
        return conversation;
    }

    private sealed class Conversation(IStepObserver observer) : IEngineConversation
    {
        private readonly List<FunctionStep> _functionSteps = [];
        private AIAgent? _agent;
        private AgentSession? _session;

        public void OnFunctionStep(FunctionStep step)
        {
            _functionSteps.Add(step);
            observer.OnStep(step);
        }

        public async Task StartAsync(AIAgent agent, CancellationToken cancellationToken)
        {
            _agent = agent;
            _session = await agent.CreateSessionAsync(cancellationToken);
        }

        public async Task<TurnResult> AskAsync(string text, CancellationToken cancellationToken = default)
        {
            _functionSteps.Clear();
            var response = await _agent!.RunAsync(text, _session, cancellationToken: cancellationToken);  // the framework's loop
            var hosted = HostedSteps.From(response.Messages);
            foreach (var step in hosted)
            {
                observer.OnStep(step);
            }
            var usage = response.Usage is { } u
                ? new TokenUsage((int)(u.InputTokenCount ?? 0), (int)(u.CachedInputTokenCount ?? 0), (int)(u.OutputTokenCount ?? 0))
                : TokenUsage.None;
            return new TurnResult(response.Text.Trim(), [.. hosted, .. _functionSteps], usage);
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;  // the framework's session lives in memory
    }
}
