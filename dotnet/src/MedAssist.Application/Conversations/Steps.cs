using MedAssist.Domain;

namespace MedAssist.Application;

/// <summary>One thing the agent did on the way to its reply.</summary>
public abstract record Step(string Tool);

/// <summary>Foundry searched the practice documents.</summary>
public sealed record FileSearchStep(IReadOnlyList<string> Queries) : Step("file_search");

/// <summary>Foundry ran code (a calculation).</summary>
public sealed record CodeInterpreterStep(string Code) : Step("code_interpreter");

/// <summary>Our code ran one of the clinic's function tools.</summary>
public sealed record FunctionStep(string Name, string ArgumentsJson, ToolResult Result) : Step(Name);

/// <summary>Tokens one turn used, over every model call in it.</summary>
public sealed record TokenUsage(int Input, int CachedInput, int Output)
{
    public static readonly TokenUsage None = new(0, 0, 0);

    public static TokenUsage operator +(TokenUsage a, TokenUsage b) =>
        new(a.Input + b.Input, a.CachedInput + b.CachedInput, a.Output + b.Output);
}

/// <summary>The agent's reply to one patient message, the steps on the way, and what it used.</summary>
public sealed record TurnResult(string Reply, IReadOnlyList<Step> Steps, TokenUsage Usage);

/// <summary>Hears each step as it happens (Observer): the command line prints them, the API needs none.</summary>
public interface IStepObserver
{
    void OnStep(Step step);
}

public sealed class NullStepObserver : IStepObserver
{
    public static readonly NullStepObserver Instance = new();

    public void OnStep(Step step)
    {
    }
}
