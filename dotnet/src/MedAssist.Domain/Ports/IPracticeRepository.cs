namespace MedAssist.Domain;

/// <summary>A search for free slots. Times are the practice's local ISO strings.</summary>
public sealed record FreeSlotQuery(string Role, string Kind, string After, string From, string ClinicianLike, string TimeOfDay,
                                   int Limit = 6);

public sealed record FreeSlot(string SlotId, string StartsAt, string Clinician);

public sealed record SlotDetails(string SlotId, string StartsAt, string Kind, string Clinician);

public sealed record BookedSlot(string SlotId, string StartsAt, string Kind, string? Reason, string Clinician);

public sealed record SentText(string SentAt, string SentTo, string Body);

public sealed record AuditEntry(string At, string Actor, string Action, string Detail);

public sealed record CallLine(string At, string CallId, string Speaker, string Text);

/// <summary>
/// The practice's systems of record: what the rules read and change. The rules in <see cref="PatientSession"/>
/// depend on this, not on SQLite, so they can be tested against any store.
/// </summary>
public interface IPracticeRepository : IDisposable
{
    Patient? FindPatient(string patientId);

    string? ClinicianName(string clinicianId);

    IReadOnlyList<FreeSlot> FindFreeSlots(FreeSlotQuery query);

    SlotDetails? FindSlot(string slotId);

    /// <summary>Gives the slot to the patient only if it is still free, in one statement. False if someone else has it.</summary>
    bool TryClaimSlot(string slotId, string patientId, string reason, string bookedAt);

    void ReleaseSlot(string slotId);

    IReadOnlyList<BookedSlot> UpcomingFor(string patientId, string after);

    void AddText(string patientId, string sentTo, string body, string sentAt);

    void AddAudit(string patientId, string action, string detail, string at);

    IReadOnlyList<SentText> TextsFor(string patientId, int limit);

    IReadOnlyList<AuditEntry> AuditFor(string patientId, int limit);

    IReadOnlyList<CallLine> CallsFor(string patientId, int limit);

    int CountTexts();

    /// <summary>Bookings MedAssist made, from the audit log, for slots whose id starts with <paramref name="slotPrefix"/>.</summary>
    int CountBookings(string slotPrefix);
}
