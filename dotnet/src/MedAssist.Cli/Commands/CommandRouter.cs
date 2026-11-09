using MedAssist.Application;
using MedAssist.Domain;

namespace MedAssist.Cli;

/// <summary>What a command was asked to do: who is signed in (P001, Valeria Romano, unless --patient says).</summary>
public sealed record CommandContext(string PatientId);

/// <summary>One verb of the command line (Command pattern). Adding one means adding a class and registering it.</summary>
public interface ICommand
{
    string Name { get; }

    string Summary { get; }

    Task<int> RunAsync(CommandContext context, CancellationToken cancellationToken = default);
}

/// <summary>
/// Picks the command named first on the command line and runs it. A failure any layer reports is printed as its
/// message, through the same classifiers the API uses, and the exit code is 1; a usage mistake is 2.
/// </summary>
public sealed class CommandRouter(IEnumerable<ICommand> commands, FailureReporter failures, IConsole console)
{
    private readonly Dictionary<string, ICommand> _commands = commands.ToDictionary(c => c.Name);

    public async Task<int> RunAsync(IReadOnlyList<string> args, CancellationToken cancellationToken = default)
    {
        var name = args.Count > 0 ? args[0] : "";
        var patient = Option(args, "--patient") ?? "P001";
        if (!_commands.TryGetValue(name, out var command) || PracticeData.FindPatient(patient) is null)
        {
            console.Error(Usage());
            return 2;
        }
        try
        {
            return await command.RunAsync(new CommandContext(patient), cancellationToken);
        }
        catch (Exception exc) when (exc is not OperationCanceledException)
        {
            console.Error(failures.Classify(exc).Message);
            return 1;
        }
    }

    public string Usage() =>
        "Usage: medassist <command> [--patient P001..P009] [--engine prompt-agent|agent-framework]\n" +
        string.Join("\n", _commands.Values.Select(c => $"  {c.Name,-8} {c.Summary}"));

    private static string? Option(IReadOnlyList<string> args, string name)
    {
        for (var i = 0; i < args.Count - 1; i++)
        {
            if (args[i] == name)
            {
                return args[i + 1];
            }
        }
        return null;
    }
}
