using MedAssist.Domain;

namespace MedAssist.Application;

/// <summary>
/// A signed-in patient's conversation: the session (the rules) and the engine's conversation together. It starts
/// each turn on the session before the agent sees the message, so every caller gets the turn order the rules need,
/// whichever engine is running.
/// </summary>
public sealed class PatientConversation(PatientSession session, IEngineConversation engine) : IAsyncDisposable
{
    public PatientSession Session { get; } = session;

    public async Task<TurnResult> AskAsync(string text, CancellationToken cancellationToken = default)
    {
        Session.NextTurn();
        return await engine.AskAsync(text, cancellationToken);
    }

    public async ValueTask DisposeAsync()
    {
        await engine.DisposeAsync();
        Session.Dispose();
    }

    /// <summary>Opens the patient's session and starts the engine's conversation; the session is closed again if that fails.</summary>
    public static async Task<PatientConversation> StartAsync(IMedAssistEngine engine, PatientSession session, IStepObserver observer,
                                                             CancellationToken cancellationToken = default)
    {
        try
        {
            return new PatientConversation(session, await engine.StartAsync(session, observer, cancellationToken));
        }
        catch
        {
            session.Dispose();
            throw;
        }
    }
}
