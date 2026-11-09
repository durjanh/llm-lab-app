namespace MedAssist.Domain;

/// <summary>What find_appointments was asked for, as the model sent it.</summary>
public sealed record FindAppointmentsRequest(string AppointmentType, string Clinician, string EarliestDate, string TimeOfDay);

/// <summary>What book_appointment was asked for.</summary>
public sealed record BookAppointmentRequest(string SlotId, string Reason);

/// <summary>What cancel_appointment was asked for.</summary>
public sealed record CancelAppointmentRequest(string AppointmentId);

/// <summary>There is no such patient in the practice.</summary>
public sealed class PatientNotFoundException(string patientId) : Exception($"No patient {patientId}")
{
    public string PatientId { get; } = patientId;
}

/// <summary>
/// What MedAssist may do for one signed-in patient during one conversation. The model decides what to do; these
/// rules decide what it is allowed to do, because a prompt is a request the model does not always follow:
/// <list type="bullet">
/// <item>The signed-in patient is fixed when the session starts. No tool takes a patient id, so the model cannot be
/// talked into reading or booking for someone else.</item>
/// <item>The model's arguments are untrusted. Booking accepts only a free slot that find_appointments showed the
/// patient in an earlier turn, so the patient has seen the slots and chosen; the repository claims the slot in one
/// conditional update, so two patients cannot get the same slot.</item>
/// <item>Cancelling takes two calls in two turns: the first only asks the patient to confirm.</item>
/// <item>Every read of a record and every change is written to the audit log.</item>
/// <item>A text that fails is audited and never undoes the booking.</item>
/// </list>
/// It depends only on ports (<see cref="IPracticeRepository"/>, <see cref="INotifier"/>) and a
/// <see cref="TimeProvider"/>, so the rules are tested without a database server or a clock. A port of
/// clinic.Session in examples/medassist/clinic.py.
/// </summary>
public sealed class PatientSession : IDisposable
{
    private readonly IPracticeRepository _practice;
    private readonly INotifier _notifier;
    private readonly TimeProvider _time;
    private readonly Dictionary<string, int> _offered = [];  // slot id -> the turn find_appointments showed it
    private readonly Dictionary<string, int> _cancelling = [];  // appointment id -> the turn confirmation was asked

    public PatientSession(IPracticeRepository practice, string patientId, INotifier notifier, TimeProvider time,
                          string language = "")
    {
        _practice = practice;
        _notifier = notifier;
        _time = time;
        Patient = practice.FindPatient(patientId) ?? throw new PatientNotFoundException(patientId);
        Language = language.Length > 0 ? language : PracticeData.PreferredLanguage.GetValueOrDefault(patientId, "en");
    }

    public Patient Patient { get; }

    /// <summary>The patient's message number. Whoever runs the loop adds one per message: the rules depend on it.</summary>
    public int Turn { get; private set; }

    /// <summary>The patient's preferred language for texts.</summary>
    public string Language { get; }

    /// <summary>The practice's records, for checks on what really changed (the checked tests read them).</summary>
    public IPracticeRepository Practice => _practice;

    /// <summary>A new patient message has arrived. Call once per message, before the agent sees it.</summary>
    public void NextTurn() => Turn++;

    /// <summary>What the portal tells the agent at the start of a conversation: the date, and who is signed in.</summary>
    public string PortalNote()
    {
        var today = _time.Today();
        return $"Today is {today:dddd dd MMMM yyyy} ({PracticeCalendar.Day(today)}). " +
               $"The signed-in patient is {Patient.Name}; the portal has verified who they are.";
    }

    public PatientRecord GetMyRecord()
    {
        var gp = _practice.ClinicianName(Patient.RegisteredGp);
        Audit("record viewed");
        return new PatientRecord(Patient.Name, Patient.DateOfBirth, gp, Patient.Allergies, Patient.Conditions,
                                 Patient.Medications, "ending " + Patient.Phone[^3..], Upcoming());
    }

    public ToolResult FindAppointments(FindAppointmentsRequest request)
    {
        if (!PracticeData.AppointmentTypes.TryGetValue(request.AppointmentType, out var type))
        {
            return new ToolError($"appointment_type must be one of {string.Join(", ", PracticeData.AppointmentTypes.Keys)}");
        }
        var now = PracticeCalendar.Minutes(_time.Now());
        var day = request.EarliestDate.Length >= 10 ? request.EarliestDate[..10] : request.EarliestDate;
        var from = DateOnly.TryParseExact(day, "yyyy-MM-dd", out var earliest) && string.CompareOrdinal(PracticeCalendar.Day(earliest), now) > 0
            ? PracticeCalendar.Day(earliest)
            : now;  // never before now; ISO strings compare in time order
        var slots = _practice.FindFreeSlots(new FreeSlotQuery(type.Role, type.Kind, now, from, request.Clinician.Trim(),
                                                              request.TimeOfDay));
        foreach (var slot in slots)
        {
            _offered.TryAdd(slot.SlotId, Turn);
        }
        return slots.Count == 0
            ? new FreeSlots([], "Nothing free in the next four weeks. Suggest another clinician, a phone call, or calling " +
                                "reception on 01632 960 123.")
            : new FreeSlots([.. slots.Select(s => new SlotOffer(s.SlotId, s.Clinician, PracticeCalendar.Spoken(s.StartsAt)))]);
    }

    public ToolResult BookAppointment(BookAppointmentRequest request)
    {
        var slotId = request.SlotId;
        if (!_offered.TryGetValue(slotId, out var shownIn))
        {
            return new ToolError("Book only a slot that find_appointments offered in this conversation.");
        }
        if (shownIn == Turn)
        {
            return new ToolError("Not booked: the patient has not seen these slots yet. Show them as a numbered list and " +
                                 "book the one the patient chooses.");
        }
        var slot = _practice.FindSlot(slotId);
        if (slot is null || string.CompareOrdinal(slot.StartsAt, PracticeCalendar.Minutes(_time.Now())) <= 0)
        {
            return new ToolError("That slot is no longer available. Find another.");
        }
        var when = PracticeCalendar.Spoken(slot.StartsAt);
        if (Upcoming().Any(a => a.When == when))
        {
            return new ToolError("The patient already has an appointment at that time.");
        }
        var reason = request.Reason.Length > 200 ? request.Reason[..200] : request.Reason;
        if (!_practice.TryClaimSlot(slotId, Patient.Id, reason, Stamp()))
        {
            return new ToolError("Someone else has just booked that slot. Find another.");
        }
        var sentTo = Text($"Harbourside Medical Centre: your appointment with {slot.Clinician} is on {when}. Ref {slotId}. " +
                          "To cancel, use the app or call 01632 960 123.");
        Audit("appointment booked", $"{slotId} with {slot.Clinician}: {reason}");
        var reminder = Notify("reminder kept", n => n.Schedule(slotId, Patient.Name,
            $"Harbourside Medical Centre: a reminder that your appointment with {slot.Clinician} is tomorrow, {when}. " +
            $"Ref {slotId}. To cancel, use the app or call 01632 960 123.", slot.StartsAt, Language));
        return new AppointmentBooked(slotId, slot.Clinician, when, slot.Kind.Replace('_', ' '), sentTo)
        {
            Reminder = reminder is null ? null : "a text the day before",
            NextStep = slotId.StartsWith("SHA-", StringComparison.Ordinal)
                ? "Search the practice documents for how to prepare for this nurse appointment and tell the patient, " +
                  "keeping any conditions the documents give."
                : null,
        };
    }

    public ToolResult CancelAppointment(CancelAppointmentRequest request)
    {
        var id = request.AppointmentId;
        var appointment = Upcoming().FirstOrDefault(a => a.AppointmentId == id);
        if (appointment is null)  // someone else's, in the past, or made up
        {
            return new ToolError("That is not one of the patient's upcoming appointments.");
        }
        if (_cancelling.GetValueOrDefault(id, Turn) == Turn)
        {
            _cancelling[id] = Turn;
            return new ConfirmCancel($"Ask the patient to confirm cancelling {appointment.With} on {appointment.When}. Call " +
                                     "cancel_appointment again after they say yes.");
        }
        _practice.ReleaseSlot(id);
        Notify("reminder dropped", n => n.Cancel(id));
        var sentTo = Text($"Harbourside Medical Centre: your appointment with {appointment.With} on {appointment.When} " +
                          "has been cancelled.");
        Audit("appointment cancelled", $"{id} with {appointment.With}");
        return new AppointmentCancelled(id, appointment.With, appointment.When, sentTo);
    }

    /// <summary>The patient's upcoming appointments, soonest first.</summary>
    public IReadOnlyList<Appointment> Upcoming() =>
        [.. _practice.UpcomingFor(Patient.Id, PracticeCalendar.Minutes(_time.Now())).Select(Appointment.From)];

    public void Dispose() => _practice.Dispose();

    private void Audit(string action, string detail = "") => _practice.AddAudit(Patient.Id, action, detail, Stamp());

    /// <summary>Sends an SMS: a row in messages, and a real text when the notifier sends them. Returns the masked
    /// number, which is all the model needs.</summary>
    private string Text(string body)
    {
        _practice.AddText(Patient.Id, Patient.Phone, body, Stamp());
        Notify("text sent", n => n.Send(Patient.Name, body, Language));
        return "mobile ending " + Patient.Phone[^3..];
    }

    /// <summary>Runs one real-text step. A failure is audited, not thrown: the booking stands.</summary>
    private string? Notify(string action, Func<INotifier, string?> step)
    {
        string? result;
        try
        {
            result = step(_notifier);
        }
        catch (Exception exc)  // the network, Azure, a number it refuses
        {
            var message = exc.Message.Length > 200 ? exc.Message[..200] : exc.Message;
            Audit($"{action}: failed", $"{exc.GetType().Name}: {message}");
            return null;
        }
        if (result is not null)
        {
            Audit(action, result);
        }
        return result;
    }

    private string Stamp() => PracticeCalendar.Stamp(_time.Now());
}
