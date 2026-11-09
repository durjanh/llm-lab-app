using MedAssist.Application;
using MedAssist.Cli;
using MedAssist.Domain;
using MedAssist.Integrations.Foundry;
using MedAssist.Testing;
using Microsoft.Extensions.Options;

namespace MedAssist.Cli.Tests;

/// <summary>The command line with a scripted console, a fake engine and fake Foundry ports: no Azure, no terminal.</summary>
public class CommandTests
{
    private TempPractice _practice = null!;
    private ScriptedConsole _console = null!;

    [SetUp]
    public void Build()
    {
        _practice = new TempPractice();
        _console = new ScriptedConsole();
    }

    [TearDown]
    public void Clean() => _practice.Dispose();

    [Test]
    public async Task An_unknown_command_or_patient_prints_the_usage_and_exits_2()
    {
        var router = Router(new ResetCommand(_practice.Practice, _console));

        (await router.RunAsync(["fly"])).Should().Be(2);
        (await router.RunAsync(["reset", "--patient", "P999"])).Should().Be(2);
        _console.Errors.Should().AllSatisfy(e => e.Should().StartWith("Usage: medassist"));
    }

    [Test]
    public async Task A_failure_is_printed_as_its_message_and_exits_1()
    {
        var router = Router(new Failing());

        (await router.RunAsync(["fail"])).Should().Be(1);
        _console.Errors.Should().Equal("No Foundry settings.");
    }

    [Test]
    public async Task Chat_talks_until_an_empty_line_and_shows_each_step()
    {
        var engine = new FakeEngine
        {
            Reply = (session, text) => new TurnResult($"Hello {session.Patient.Name}.", [new FileSearchStep(["hours"])], TokenUsage.None),
        };
        _console.Input.Enqueue("Hi");
        _console.Input.Enqueue("");

        var code = await Router(new ChatCommand(engine, _practice.Practice, _console)).RunAsync(["chat", "--patient", "P003"]);

        code.Should().Be(0);
        _console.Output.Should().Contain("  [file search] hours").And.Contain("\nMedAssist: Hello Margaret Ellis.\n");
        engine.Ended.Should().Be(1, "the conversation is ended when the chat finishes");
    }

    [Test]
    public async Task Records_prints_the_patients_appointments_without_azure()
    {
        await Router(new RecordsCommand(_practice.Practice, _console)).RunAsync(["records"]);

        _console.Output.Should().Contain("Valeria Romano (P001), born 1986-05-14").And.Contain("Annual asthma review");
    }

    [Test]
    public async Task Create_uploads_the_documents_and_saves_the_agent_with_the_clinics_tools()
    {
        var knowledge = new FakeKnowledge();
        var agents = new FakeAgents();
        var documents = new FixedDocuments([new KnowledgeDocument("guide.md", "hours"u8.ToArray())]);
        var create = new CreateCommand(documents, knowledge, agents, ClinicToolbox.Standard(),
                                       Options.Create(new FoundryOptions { Model = "gpt-5.4-mini" }), _console);

        (await Router(create).RunAsync(["create"])).Should().Be(0);

        knowledge.Uploaded.Should().Equal("guide.md");
        var saved = agents.Saved.Should().ContainSingle().Subject;
        saved.Model.Should().Be("gpt-5.4-mini");
        saved.KnowledgeStoreId.Should().Be("vs-1");
        saved.FunctionTools.Select(t => t.Name).Should().Contain("book_appointment");
        _console.Output.Should().Contain("Saved MedAssist version 3.");
    }

    private CommandRouter Router(params ICommand[] commands) =>
        new(commands, new FailureReporter([new ServiceFailureClassifier()]), _console);

    private sealed class ScriptedConsole : IConsole
    {
        private readonly System.Text.StringBuilder _output = new();

        public Queue<string> Input { get; } = new();

        public List<string> Errors { get; } = [];

        public string Output => _output.ToString();

        public string? ReadLine() => Input.Count > 0 ? Input.Dequeue() : null;

        public void Write(string text) => _output.Append(text);

        public void WriteLine(string text = "") => _output.Append(text).Append('\n');

        public void Error(string text) => Errors.Add(text);
    }

    private sealed class Failing : ICommand
    {
        public string Name => "fail";

        public string Summary => "always fails";

        public Task<int> RunAsync(CommandContext context, CancellationToken cancellationToken = default) =>
            throw new ServiceException(FailureKind.NotConfigured, "No Foundry settings.");
    }

    private sealed class FixedDocuments(IReadOnlyList<KnowledgeDocument> documents) : IKnowledgeDocuments
    {
        public IReadOnlyList<KnowledgeDocument> Load() => documents;
    }

    private sealed class FakeKnowledge : IKnowledgeBase
    {
        public List<string> Uploaded { get; } = [];

        public Task<string?> FindStoreAsync(CancellationToken cancellationToken = default) => Task.FromResult<string?>("vs-1");

        public Task<KnowledgeIndex> ReplaceAsync(IReadOnlyList<KnowledgeDocument> documents, CancellationToken cancellationToken = default)
        {
            Uploaded.AddRange(documents.Select(d => d.FileName));
            return Task.FromResult(new KnowledgeIndex("vs-1", documents.Count, documents.Count));
        }

        public Task<IReadOnlyList<string>> DeleteAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult<IReadOnlyList<string>>(["vs-1"]);
    }

    private sealed class FakeAgents : IAgentCatalog
    {
        public List<AgentDefinition> Saved { get; } = [];

        public Task<SavedAgent> SaveVersionAsync(AgentDefinition definition, CancellationToken cancellationToken = default)
        {
            Saved.Add(definition);
            return Task.FromResult(new SavedAgent(definition.Name, "3"));
        }

        public Task<string?> LatestVersionAsync(string agentName, CancellationToken cancellationToken = default) => Task.FromResult<string?>("3");

        public Task<bool> DeleteAsync(string agentName, CancellationToken cancellationToken = default) => Task.FromResult(true);
    }
}
