using MedAssist.Application;
using MedAssist.Domain;
using MedAssist.Integrations.Foundry.PromptAgent;
using MedAssist.Testing;
using Microsoft.Extensions.Options;
using OpenAI.Responses;

namespace MedAssist.Integrations.Tests;

/// <summary>Our own tool loop against scripted model responses, in the shapes Foundry sends: no Azure.</summary>
public class ToolLoopTests
{
    private TempPractice _practice = null!;
    private PatientSession _session = null!;

    [SetUp]
    public void Build()
    {
        _practice = new TempPractice();
        _session = _practice.Session("P002");
        _session.NextTurn();
    }

    [TearDown]
    public void Clean()
    {
        _session.Dispose();
        _practice.Dispose();
    }

    [Test]
    public async Task A_function_call_runs_against_the_session_and_its_result_goes_back_to_the_agent()
    {
        var agent = new ScriptedAgent(
            Response(ResponseItem.CreateFunctionCallItem("call-1", "get_my_record", BinaryData.FromString("{}"))),
            Response(ResponseItem.CreateAssistantMessageItem("Your GP is Dr Tom Okafor.")));
        var observed = new List<Step>();

        var turn = await Loop().RunAsync(agent, _session, "Who is my GP?", new Observer(observed.Add));

        turn.Reply.Should().Be("Your GP is Dr Tom Okafor.");
        var step = turn.Steps.Should().ContainSingle().Which.Should().BeOfType<FunctionStep>().Subject;
        step.Result.Should().BeOfType<PatientRecord>().Which.Name.Should().Be("Sam Taylor");
        observed.Should().Equal(turn.Steps);
        var output = agent.Inputs[1].Should().ContainSingle().Which.Should().BeOfType<FunctionCallOutputResponseItem>().Subject;
        output.CallId.Should().Be("call-1");
        output.FunctionOutput.Should().Contain("\"name\":\"Sam Taylor\"");
    }

    [Test]
    public async Task Hosted_tools_are_reported_and_need_nothing_sent_back()
    {
        var agent = new ScriptedAgent(Response(ResponseItem.CreateFileSearchCallItem(["opening hours"]),
                                               ResponseItem.CreateAssistantMessageItem("We open at 08:00.")));

        var turn = await Loop().RunAsync(agent, _session, "When do you open?", NullStepObserver.Instance);

        turn.Steps.Should().ContainSingle().Which.Should().BeOfType<FileSearchStep>().Which.Queries.Should().Equal("opening hours");
        agent.Inputs.Should().HaveCount(1);
    }

    [Test]
    public async Task A_message_sent_twice_is_shown_once()
    {
        var agent = new ScriptedAgent(Response(ResponseItem.CreateAssistantMessageItem("Hello."), ResponseItem.CreateAssistantMessageItem("Hello.")));
        (await Loop().RunAsync(agent, _session, "Hi", NullStepObserver.Instance)).Reply.Should().Be("Hello.");
    }

    [Test]
    public async Task The_loop_stops_after_the_most_rounds_allowed()
    {
        var call = Response(ResponseItem.CreateFunctionCallItem("c", "get_my_record", BinaryData.FromString("{}")));
        var agent = new ScriptedAgent(Enumerable.Repeat(call, 10).ToArray());
        _practice.Options.MaxRounds = 3;

        var turn = await Loop().RunAsync(agent, _session, "loop", NullStepObserver.Instance);

        turn.Reply.Should().Contain("too many tool calls");
        agent.Inputs.Should().HaveCount(4);  // the message, then three rounds of results
    }

    [Test]
    public async Task The_prompt_agent_engine_opens_each_conversation_with_the_portal_note()
    {
        var conversations = new RecordingConversations();
        var engine = new PromptAgentEngine(conversations, Loop(), new MissingAgentCatalog(),
                                           Options.Create(new Foundry.FoundryOptions { Model = "m" }), new FailureReporter([]));

        await using var conversation = await engine.StartAsync(_session, NullStepObserver.Instance);

        conversations.Started.Should().ContainSingle().Which.Should().Be(("MedAssist", _session.PortalNote()));
        (await engine.GetStatusAsync()).Should().Match<EngineStatus>(s => !s.Ready && s.Problem.Contains("medassist create"));
    }

    private ToolLoop Loop() => new(ClinicToolbox.Standard(), _practice.OptionsWrapper);

    private static ResponseResult Response(params ResponseItem[] items)
    {
        var response = new ResponseResult();
        foreach (var item in items)
        {
            response.OutputItems.Add(item);
        }
        return response;
    }

    private sealed class ScriptedAgent(params ResponseResult[] responses) : IAgentResponder
    {
        private int _next;

        public List<IReadOnlyList<ResponseItem>> Inputs { get; } = [];

        public Task<ResponseResult> RespondAsync(IReadOnlyList<ResponseItem> input, CancellationToken cancellationToken = default)
        {
            Inputs.Add(input);
            return Task.FromResult(responses[_next++]);
        }
    }

    private sealed class Observer(Action<Step> onStep) : IStepObserver
    {
        public void OnStep(Step step) => onStep(step);
    }

    private sealed class RecordingConversations : IPromptAgentConversations
    {
        public List<(string Agent, string Note)> Started { get; } = [];

        public Task<IAgentConversation> StartAsync(string agentName, string developerNote, CancellationToken cancellationToken = default)
        {
            Started.Add((agentName, developerNote));
            return Task.FromResult<IAgentConversation>(new Nothing());
        }

        private sealed class Nothing : IAgentConversation
        {
            public Task<ResponseResult> RespondAsync(IReadOnlyList<ResponseItem> input, CancellationToken cancellationToken = default) =>
                Task.FromResult(new ResponseResult());

            public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        }
    }

    private sealed class MissingAgentCatalog : IAgentCatalog
    {
        public Task<SavedAgent> SaveVersionAsync(AgentDefinition definition, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public Task<string?> LatestVersionAsync(string agentName, CancellationToken cancellationToken = default) =>
            Task.FromResult<string?>(null);

        public Task<bool> DeleteAsync(string agentName, CancellationToken cancellationToken = default) => Task.FromResult(false);
    }
}
