using MedAssist.Domain;
using Microsoft.Extensions.Options;

namespace MedAssist.Application;

/// <summary>What staff see for one patient: the record, upcoming appointments, texts sent, the audit log and calls.</summary>
public sealed record PracticeRecords(Patient Patient, string? RegisteredGp, IReadOnlyList<Appointment> Upcoming,
                                     IReadOnlyList<SentText> Texts, IReadOnlyList<AuditEntry> Audit, IReadOnlyList<CallLine> Calls);

/// <summary>One patient as the portal lists them: with their age, and the language they prefer.</summary>
public sealed record PatientSummary(string Id, string Name, int Age, string Language);

/// <summary>
/// The practice's database, as the services use it: opening a patient's session, reading their records, and
/// rebuilding it. It talks to the database only through the domain's store and repository interfaces.
/// </summary>
public sealed class PracticeService(IPracticeStoreFactory stores, IOptions<MedAssistOptions> options, TimeProvider time,
                                    INotifier notifier)
{
    private const int Limit = 20;

    /// <summary>The live database, which the lab's page and the Python version share.</summary>
    public IPracticeStore Live => stores.At(options.Value.DatabasePath);

    /// <summary>The checked tests' own database.</summary>
    public IPracticeStore Tests => stores.At(options.Value.TestDatabasePath);

    public IReadOnlyList<PatientSummary> Patients()
    {
        var today = time.Today();
        return [.. PracticeData.Patients.Select(p => new PatientSummary(p.Id, p.Name, p.AgeOn(today),
            PracticeData.LanguageNames.GetValueOrDefault(PracticeData.PreferredLanguage.GetValueOrDefault(p.Id, "en"), "English")))];
    }

    /// <summary>A session for one signed-in patient on <paramref name="store"/> (the live database unless given).</summary>
    public PatientSession OpenSession(string patientId, IPracticeStore? store = null)
    {
        store ??= Live;
        if (!store.Exists)
        {
            Recreate(store);
        }
        var repository = store.Open();
        try
        {
            return new PatientSession(repository, patientId, notifier, time);
        }
        catch
        {
            repository.Dispose();
            throw;
        }
    }

    /// <summary>The staff view. Reading it is not MedAssist reading the record, so it is not audited.</summary>
    public PracticeRecords Records(string patientId)
    {
        var store = Live;
        if (!store.Exists)
        {
            throw new ServiceException(FailureKind.NotFound, $"No practice database yet at {store.Location}: start a chat or reset it.");
        }
        using var practice = store.Open();
        var patient = practice.FindPatient(patientId) ?? throw new PatientNotFoundException(patientId);
        var upcoming = practice.UpcomingFor(patientId, PracticeCalendar.Minutes(time.Now())).Select(Appointment.From).ToList();
        return new PracticeRecords(patient, practice.ClinicianName(patient.RegisteredGp), upcoming, practice.TextsFor(patientId, Limit),
                                   practice.AuditFor(patientId, Limit), practice.CallsFor(patientId, Limit * 3));
    }

    /// <summary>Starts the live database again, with diaries from today, after keeping a copy of it, so a reset never
    /// loses a record. Returns where the copy went (null when there was no database).</summary>
    public string? Reset()
    {
        var kept = Live.KeepCopy(options.Value.BackupPath, time.Now());
        Recreate();
        return kept;
    }

    /// <summary>A fresh database, with diaries from today, and no copy kept: for a first database, or the tests' own.</summary>
    public void Recreate(IPracticeStore? store = null) => (store ?? Live).Recreate(time.Today(), time.Now());
}
