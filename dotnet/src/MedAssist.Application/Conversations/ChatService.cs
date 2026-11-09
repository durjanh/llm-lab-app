using System.Collections.Concurrent;
using MedAssist.Domain;
using Microsoft.Extensions.Options;

namespace MedAssist.Application;

/// <summary>What the portal shows about MedAssist before a conversation starts.</summary>
public sealed record MedAssistInfo(string Engine, EngineStatus Status, IReadOnlyList<PatientSummary> Patients);

public sealed record ChatStarted(string ChatId, PracticeRecords State);

public sealed record ChatReply(string Reply, IReadOnlyList<Step> Steps, decimal CostUsd, decimal TotalUsd, PracticeRecords State);

/// <summary>
/// The patient portal's conversations, as backend/app/services/medassist.py holds them for the Python page: start
/// one for a signed-in patient, send messages one at a time, end it. Each reply is charged to the spend tracker. The
/// portal, not the model, says who the patient is.
/// </summary>
public sealed class ChatService(IMedAssistEngine engine, PracticeService practice, ISpendTracker spend, IOptions<MedAssistOptions> options)
{
    private readonly ConcurrentDictionary<string, OpenChat> _chats = new();
    private readonly ConcurrentQueue<string> _order = new();  // oldest first, for ending the oldest

    public async Task<MedAssistInfo> InfoAsync(CancellationToken cancellationToken = default) =>
        new(engine.Name, await engine.GetStatusAsync(cancellationToken), practice.Patients());

    public async Task<ChatStarted> StartAsync(string patientId, CancellationToken cancellationToken = default)
    {
        RequireBudget();
        var session = practice.OpenSession(patientId);
        var conversation = await PatientConversation.StartAsync(engine, session, NullStepObserver.Instance, cancellationToken);
        var chatId = Guid.NewGuid().ToString("N");
        _chats[chatId] = new OpenChat(conversation);
        _order.Enqueue(chatId);
        await EndOldestAsync();
        return new ChatStarted(chatId, practice.Records(patientId));
    }

    public async Task<ChatReply> SendAsync(string chatId, string message, CancellationToken cancellationToken = default)
    {
        RequireBudget();
        var text = message.Trim();
        if (text.Length == 0)
        {
            throw new ServiceException(FailureKind.InvalidRequest, "message: write something to send.");
        }
        var chat = Find(chatId);
        if (!chat.Gate.Wait(0, cancellationToken))  // one message at a time: the tools depend on the turn order
        {
            throw new ServiceException(FailureKind.Busy, "MedAssist is still answering the last message.");
        }
        try
        {
            var turn = await chat.Conversation.AskAsync(text, cancellationToken);
            var cost = spend.Charge(engine.Model, turn.Usage);
            chat.CostUsd += cost;
            return new ChatReply(turn.Reply, turn.Steps, Math.Round(cost, 5), Math.Round(chat.CostUsd, 5),
                                 practice.Records(chat.Conversation.Session.Patient.Id));
        }
        finally
        {
            chat.Gate.Release();
        }
    }

    public async Task<bool> EndAsync(string chatId)
    {
        if (!_chats.TryRemove(chatId, out var chat))
        {
            return false;
        }
        await chat.Conversation.DisposeAsync();
        return true;
    }

    public PracticeRecords State(string patientId) => practice.Records(patientId);

    /// <summary>A fresh practice database, after a copy of the old one is kept. Open conversations end, because the
    /// slots they were shown are gone. Returns where the copy went.</summary>
    public async Task<string?> ResetAsync()
    {
        foreach (var chatId in _chats.Keys.ToList())
        {
            await EndAsync(chatId);
        }
        return practice.Reset();
    }

    private OpenChat Find(string chatId) =>
        _chats.TryGetValue(chatId, out var chat)
            ? chat
            : throw new ServiceException(FailureKind.NotFound, "That conversation has ended. Start a new one.");

    private void RequireBudget()
    {
        if (spend.OverBudget)
        {
            throw new ServiceException(FailureKind.BudgetExceeded,
                $"This run has spent about ${spend.SpentUsd:0.00}, which reached the ${spend.BudgetUsd:0.00} budget. " +
                "Restart the API with a higher MedAssist:BudgetUsd to continue.");
        }
    }

    private async Task EndOldestAsync()
    {
        while (_chats.Count > options.Value.MaxConversations && _order.TryDequeue(out var oldest))
        {
            await EndAsync(oldest);
        }
    }

    private sealed class OpenChat(PatientConversation conversation)
    {
        public PatientConversation Conversation { get; } = conversation;

        public SemaphoreSlim Gate { get; } = new(1, 1);

        public decimal CostUsd { get; set; }
    }
}
