using System.Text.Json;
using System.Text.Json.Serialization;

namespace MedAssist.Domain;

/// <summary>
/// What a function tool returns to the model. Each outcome has its own record, so the compiler checks every field
/// and tests can assert on the type; <see cref="ToJson"/> writes it with snake_case names, the same JSON the Python
/// version sends (book_appointment returns {"booked": true, "appointment_id": ...}).
/// </summary>
public abstract record ToolResult
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,  // optional fields are left out, not sent as null
    };

    /// <summary>The function_call_output the model reads, serialised by its runtime type so every field is written.</summary>
    public string ToJson() => JsonSerializer.Serialize(this, GetType(), Json);
}

/// <summary>A refusal or a mistake, in words the model can act on. Never an exception.</summary>
public sealed record ToolError(string Error) : ToolResult;

/// <summary>get_my_record: the signed-in patient's own record. The mobile number is masked.</summary>
public sealed record PatientRecord(string Name, string DateOfBirth, string? RegisteredGp, string Allergies, string Conditions,
                                   string Medications, string Mobile, IReadOnlyList<Appointment> UpcomingAppointments) : ToolResult;

/// <summary>find_appointments: up to six free slots, or none and a note on what to suggest instead.</summary>
public sealed record FreeSlots(IReadOnlyList<SlotOffer> Slots, string? Note = null) : ToolResult;

/// <summary>One free slot find_appointments offers.</summary>
public sealed record SlotOffer(string SlotId, string With, string When);

/// <summary>book_appointment, when the slot is now the patient's.</summary>
public sealed record AppointmentBooked(string AppointmentId, string With, string When, string Kind, string ConfirmationSentTo)
    : ToolResult
{
    [JsonPropertyOrder(-1)]
    public bool Booked => true;  // first, as the model has always seen it

    /// <summary>"a text the day before", when a real reminder was kept.</summary>
    public string? Reminder { get; init; }

    /// <summary>For a nurse appointment: look up how to prepare, before replying.</summary>
    public string? NextStep { get; init; }
}

/// <summary>cancel_appointment, the first time: nothing is cancelled until the patient says yes.</summary>
public sealed record ConfirmCancel(string ConfirmFirst) : ToolResult
{
    [JsonPropertyOrder(-1)]
    public bool Cancelled => false;
}

/// <summary>cancel_appointment, the second time, after the patient confirmed.</summary>
public sealed record AppointmentCancelled(string AppointmentId, string With, string When, string ConfirmationSentTo) : ToolResult
{
    [JsonPropertyOrder(-1)]
    public bool Cancelled => true;
}

/// <summary>One of the patient's upcoming appointments, as the tools and the records view show it. The reason is
/// always written, null when there is none, as the Python version does.</summary>
public sealed record Appointment(string AppointmentId, string With, string When, string Kind,
                                 [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Reason)
{
    public static Appointment From(BookedSlot slot) =>
        new(slot.SlotId, slot.Clinician, PracticeCalendar.Spoken(slot.StartsAt), slot.Kind.Replace('_', ' '), slot.Reason);
}
