namespace MedAssist.Application;

public sealed record ScenarioResult(string Name, bool Passed, IReadOnlyList<IReadOnlyList<string>> Turns);

/// <summary>Hears a scenario run as it goes, so a long run shows progress (Observer). The CLI prints it.</summary>
public interface IScenarioListener : IStepObserver
{
    void OnScenarioStarted(Scenario scenario);

    void OnExchange(string message, string reply);

    void OnScenarioFinished(ScenarioResult result);
}

/// <summary>
/// Runs the checked cases against the configured engine, each on a freshly built copy of the test database, and
/// checks what really changed. Model replies vary: run it more than once before trusting a change.
/// </summary>
public sealed class ScenarioRunner(IMedAssistEngine engine, PracticeService practice)
{
    public async Task<IReadOnlyList<ScenarioResult>> RunAsync(IEnumerable<Scenario> scenarios, IScenarioListener listener,
                                                              CancellationToken cancellationToken = default)
    {
        var results = new List<ScenarioResult>();
        foreach (var scenario in scenarios)
        {
            listener.OnScenarioStarted(scenario);
            var store = practice.Tests;
            practice.Recreate(store);
            var session = practice.OpenSession(Scenarios.Patient, store);
            await using var conversation = await PatientConversation.StartAsync(engine, session, listener, cancellationToken);
            var turns = new List<IReadOnlyList<string>>();
            var reply = "";
            foreach (var message in scenario.Messages)
            {
                var turn = await conversation.AskAsync(message, cancellationToken);
                reply = turn.Reply;
                turns.Add([.. turn.Steps.Select(s => s.Tool)]);
                listener.OnExchange(message, reply);
            }
            var result = new ScenarioResult(scenario.Name, scenario.Check(new ScenarioOutcome(reply, turns, session)), turns);
            results.Add(result);
            listener.OnScenarioFinished(result);
        }
        return results;
    }
}
