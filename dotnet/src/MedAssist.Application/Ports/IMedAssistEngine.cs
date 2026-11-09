using MedAssist.Domain;

namespace MedAssist.Application;

/// <summary>
/// One way of running MedAssist (Strategy): the Foundry prompt agent with our own tool loop, or Microsoft Agent
/// Framework. The services depend on this, so they work the same with either, and with a fake in tests.
/// </summary>
public interface IMedAssistEngine
{
    /// <summary>"prompt-agent" or "agent-framework": the value of MedAssist:Engine that selects it.</summary>
    string Name { get; }

    /// <summary>The model deployment it answers with, for pricing.</summary>
    string Model { get; }

    /// <summary>Whether it can answer now, and why not. Never throws: a problem is reported in the status.</summary>
    Task<EngineStatus> GetStatusAsync(CancellationToken cancellationToken = default);

    /// <summary>A new conversation for the session's patient. <paramref name="observer"/> hears each tool step as it happens.</summary>
    Task<IEngineConversation> StartAsync(PatientSession session, IStepObserver observer, CancellationToken cancellationToken = default);
}

/// <summary>One conversation with the agent. The caller starts each turn on the session before asking.</summary>
public interface IEngineConversation : IAsyncDisposable
{
    Task<TurnResult> AskAsync(string text, CancellationToken cancellationToken = default);
}

public sealed record EngineStatus(bool Configured, bool Ready, string? Model, string? Version, string Problem = "");
