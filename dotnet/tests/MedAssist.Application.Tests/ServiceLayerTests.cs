using MedAssist.Application;
using MedAssist.Domain;
using MedAssist.Testing;
using Microsoft.Extensions.Options;

namespace MedAssist.Application.Tests;

/// <summary>The scenario runner, pricing, settings and failures: each on its own, with test doubles.</summary>
public class ServiceLayerTests
{
    [Test]
    public async Task The_scenario_runner_checks_each_case_on_a_fresh_test_database()
    {
        using var practice = new TempPractice();
        var engine = new FakeEngine { Reply = (_, text) => new TurnResult(text.ToUpperInvariant(), [new FileSearchStep(["q"])], TokenUsage.None) };
        var runner = new ScenarioRunner(engine, practice.Practice);
        Scenario[] cases =
        [
            new("shouts back", ["hello"], o => o.Reply == "HELLO" && o.Turns[0].Contains("file_search")),
            new("never passes", ["hello"], _ => false),
        ];
        var listener = new RecordingListener();

        var results = await runner.RunAsync(cases, listener);

        results.Select(r => r.Passed).Should().Equal(true, false);
        listener.Events.Should().Equal("start shouts back", "step file_search", "hello -> HELLO", "PASS shouts back",
                                       "start never passes", "step file_search", "hello -> HELLO", "FAIL never passes");
        File.Exists(practice.Options.TestDatabasePath).Should().BeTrue("the cases run on the test database, not the live one");
        engine.Ended.Should().Be(2);
    }

    [Test]
    public void The_nine_checked_cases_are_the_python_versions()
    {
        Scenarios.All.Should().HaveCount(9);
        Scenarios.All.Select(s => s.Name).Should().Contain("Emergency: 999 first, nothing looked up or booked");
    }

    [Test]
    public void A_turn_is_priced_with_cached_input_at_the_cached_rate()
    {
        var pricing = Options.Create(new PricingOptions { Models = { ["m"] = new ModelPrice { Input = 0.75m, CachedInput = 0.075m, Output = 4.5m } } });
        var spend = new SpendTracker(pricing, Options.Create(new MedAssistOptions { BudgetUsd = 1m }));

        var cost = spend.Charge("m", new TokenUsage(Input: 10_000, CachedInput: 8_000, Output: 1_000));

        cost.Should().Be((2_000 * 0.75m + 8_000 * 0.075m + 1_000 * 4.5m) / 1_000_000m);
        spend.Charge("unpriced", new TokenUsage(1_000_000, 0, 0)).Should().Be(0m);
        spend.OverBudget.Should().BeFalse();
    }

    [Test]
    public void Relative_paths_are_resolved_against_the_labs_root()
    {
        var options = new MedAssistOptions { RepoRoot = "/lab" };
        new ResolveMedAssistPaths().PostConfigure(null, options);

        options.DatabasePath.Should().Be("/lab/examples/medassist/data/medassist.db");
        options.KnowledgePath.Should().Be("/lab/examples/medassist/knowledge");
    }

    [Test]
    public void Settings_that_cannot_work_are_named()
    {
        var result = new ValidateMedAssistOptions().Validate(null, new MedAssistOptions { Engine = "magic", BudgetUsd = 0 });

        result.Failed.Should().BeTrue();
        result.Failures.Should().Contain(f => f.Contains("MedAssist:Engine")).And.Contain(f => f.Contains("BudgetUsd"));
        new ValidateMedAssistOptions().Validate(null, new MedAssistOptions()).Succeeded.Should().BeTrue();
    }

    [Test]
    public void Failures_are_reported_by_the_first_classifier_that_knows_them()
    {
        var reporter = new FailureReporter([new ServiceFailureClassifier()]);

        reporter.Classify(new ServiceException(FailureKind.Busy, "Wait.")).Should().Be(new Failure(FailureKind.Busy, "busy", "Wait."));
        reporter.Classify(new PatientNotFoundException("P999")).Kind.Should().Be(FailureKind.InvalidRequest);
        reporter.Classify(new OptionsValidationException("x", typeof(object), ["Set it."])).Message.Should().Be("Set it.");
        reporter.Classify(new InvalidCastException("boom")).Type.Should().Be("server_error");
    }

    [Test]
    public void The_practice_documents_are_read_in_name_order()
    {
        using var practice = new TempPractice();
        Directory.CreateDirectory(practice.Options.KnowledgePath);
        File.WriteAllText(Path.Combine(practice.Options.KnowledgePath, "b.md"), "B");
        File.WriteAllText(Path.Combine(practice.Options.KnowledgePath, "a.md"), "A");
        File.WriteAllText(Path.Combine(practice.Options.KnowledgePath, "notes.txt"), "not a document");

        new FolderKnowledgeDocuments(practice.OptionsWrapper).Load().Select(d => d.FileName).Should().Equal("a.md", "b.md");
    }

    private sealed class RecordingListener : IScenarioListener
    {
        public List<string> Events { get; } = [];

        public void OnStep(Step step) => Events.Add($"step {step.Tool}");

        public void OnScenarioStarted(Scenario scenario) => Events.Add($"start {scenario.Name}");

        public void OnExchange(string message, string reply) => Events.Add($"{message} -> {reply}");

        public void OnScenarioFinished(ScenarioResult result) => Events.Add($"{(result.Passed ? "PASS" : "FAIL")} {result.Name}");
    }
}
