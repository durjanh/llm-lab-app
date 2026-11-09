using MedAssist.Application;
using MedAssist.Data;
using MedAssist.Domain;
using Microsoft.Extensions.Options;

namespace MedAssist.Testing;

/// <summary>A clock stopped at one moment, in UTC as the practice's local time, so every run sees the same "now".</summary>
public sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
{
    /// <summary>Monday 9 November 2026, 08:00: before the day's first slot, so all four weeks are still ahead.</summary>
    public static readonly DateTimeOffset Monday = new(2026, 11, 9, 8, 0, 0, TimeSpan.Zero);

    public FixedTimeProvider() : this(Monday)
    {
    }

    public DateTimeOffset UtcNow { get; set; } = now;

    public override DateTimeOffset GetUtcNow() => UtcNow;

    public override TimeZoneInfo LocalTimeZone => TimeZoneInfo.Utc;
}

/// <summary>
/// A practice database in a temporary folder, with the real <see cref="PracticeService"/> over the SQLite data
/// layer, created fresh for the fixed day. Deleted when disposed.
/// </summary>
public sealed class TempPractice : IDisposable
{
    public TempPractice(INotifier? notifier = null, FixedTimeProvider? time = null)
    {
        Folder = Directory.CreateTempSubdirectory("medassist-").FullName;
        Time = time ?? new FixedTimeProvider();
        Options = new MedAssistOptions
        {
            RepoRoot = Folder,
            DatabasePath = Path.Combine(Folder, "medassist.db"),
            TestDatabasePath = Path.Combine(Folder, "test.db"),
            KnowledgePath = Path.Combine(Folder, "knowledge"),
            BackupPath = Path.Combine(Folder, "databases"),
            MaxConversations = 2,
        };
        Practice = new PracticeService(new SqlitePracticeStoreFactory(), Microsoft.Extensions.Options.Options.Create(Options), Time,
                                       notifier ?? NullNotifier.Instance);
        Practice.Recreate();
    }

    public string Folder { get; }

    public FixedTimeProvider Time { get; }

    public MedAssistOptions Options { get; }

    public PracticeService Practice { get; }

    public IOptions<MedAssistOptions> OptionsWrapper => Microsoft.Extensions.Options.Options.Create(Options);

    public PatientSession Session(string patientId) => Practice.OpenSession(patientId);

    public void Dispose() => Directory.Delete(Folder, recursive: true);
}

/// <summary>
/// An engine whose replies are scripted: each turn calls <see cref="Reply"/> with the session and the message, which
/// may call the clinic's tools on the session as a model would. Records what happened, for the tests to check.
/// </summary>
public sealed class FakeEngine : IMedAssistEngine
{
    public string Name => "fake";

    public string Model { get; set; } = "fake-model";

    public EngineStatus Status { get; set; } = new(true, true, "fake-model", "7");

    public Func<PatientSession, string, TurnResult> Reply { get; set; } =
        (_, text) => new TurnResult($"You said: {text}", [], new TokenUsage(1000, 0, 100));

    public List<string> Started { get; } = [];

    public int Ended { get; private set; }

    public Task<EngineStatus> GetStatusAsync(CancellationToken cancellationToken = default) => Task.FromResult(Status);

    public Task<IEngineConversation> StartAsync(PatientSession session, IStepObserver observer, CancellationToken cancellationToken = default)
    {
        Started.Add(session.Patient.Id);
        return Task.FromResult<IEngineConversation>(new Conversation(this, session, observer));
    }

    private sealed class Conversation(FakeEngine engine, PatientSession session, IStepObserver observer) : IEngineConversation
    {
        public Task<TurnResult> AskAsync(string text, CancellationToken cancellationToken = default)
        {
            var turn = engine.Reply(session, text);
            foreach (var step in turn.Steps)
            {
                observer.OnStep(step);
            }
            return Task.FromResult(turn);
        }

        public ValueTask DisposeAsync()
        {
            engine.Ended++;
            return ValueTask.CompletedTask;
        }
    }
}

/// <summary>
/// A repository with nothing behind it but what a test sets, for testing the rules without any database. Each
/// call answers from the fields below.
/// </summary>
public sealed class StubRepository : IPracticeRepository
{
    public Patient Patient { get; set; } = PracticeData.Patients[1];  // Sam Taylor

    public List<FreeSlot> Free { get; } = [];

    public Dictionary<string, SlotDetails> Slots { get; } = [];

    public bool ClaimSucceeds { get; set; } = true;

    public List<string> Audit { get; } = [];

    public List<string> TextsSent { get; } = [];

    public Patient? FindPatient(string patientId) => patientId == Patient.Id ? Patient : null;

    public string? ClinicianName(string clinicianId) => "Dr Tom Okafor";

    public IReadOnlyList<FreeSlot> FindFreeSlots(FreeSlotQuery query) => Free;

    public SlotDetails? FindSlot(string slotId) => Slots.GetValueOrDefault(slotId);

    public bool TryClaimSlot(string slotId, string patientId, string reason, string bookedAt) => ClaimSucceeds;

    public void ReleaseSlot(string slotId)
    {
    }

    public IReadOnlyList<BookedSlot> UpcomingFor(string patientId, string after) => [];

    public void AddText(string patientId, string sentTo, string body, string sentAt) => TextsSent.Add(body);

    public void AddAudit(string patientId, string action, string detail, string at) => Audit.Add(action);

    public IReadOnlyList<SentText> TextsFor(string patientId, int limit) => [];

    public IReadOnlyList<AuditEntry> AuditFor(string patientId, int limit) => [];

    public IReadOnlyList<CallLine> CallsFor(string patientId, int limit) => [];

    public int CountTexts() => TextsSent.Count;

    public int CountBookings(string slotPrefix) => 0;

    public void Dispose()
    {
    }
}
