using MedAssist.Application;

namespace MedAssist.Cli;

/// <summary>The terminal, behind an interface, so commands are tested with scripted input and captured output.</summary>
public interface IConsole
{
    string? ReadLine();

    void Write(string text);

    void WriteLine(string text = "");

    void Error(string text);
}

public sealed class SystemConsole : IConsole
{
    public string? ReadLine() => System.Console.ReadLine();

    public void Write(string text) => System.Console.Write(text);

    public void WriteLine(string text = "") => System.Console.WriteLine(text);

    public void Error(string text) => System.Console.Error.WriteLine(text);
}

/// <summary>Prints each step as the Python versions do, so a run reads the same in either; and a test run's progress.</summary>
public sealed class ConsoleProgress(IConsole console) : IScenarioListener
{
    public void OnStep(Step step)
    {
        switch (step)
        {
            case FileSearchStep search:
                console.WriteLine($"  [file search] {string.Join("; ", search.Queries)}");
                break;
            case CodeInterpreterStep code:
                console.WriteLine("  [code interpreter]");
                foreach (var line in code.Code.Split('\n'))
                {
                    console.WriteLine($"    {line}");
                }
                break;
            case FunctionStep function:
                var result = function.Result.ToJson();
                console.WriteLine($"  [{function.Name}] {function.ArgumentsJson}\n    -> {(result.Length > 400 ? result[..400] : result)}");
                break;
        }
    }

    public void OnScenarioStarted(Scenario scenario) => console.WriteLine($"\n=== {scenario.Name} ===");

    public void OnExchange(string message, string reply) => console.WriteLine($"You: {message}\nMedAssist: {reply}\n");

    public void OnScenarioFinished(ScenarioResult result) =>
        console.WriteLine($"{(result.Passed ? "PASS" : "FAIL")}: {result.Name} " +
                          $"(tools by turn: [{string.Join(", ", result.Turns.Select(t => $"[{string.Join(", ", t)}]"))}])");
}
