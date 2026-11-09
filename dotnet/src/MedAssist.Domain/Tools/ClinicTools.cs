using System.Text.Json;

namespace MedAssist.Domain;

/// <summary>One function tool as the model sees it: its name, what it is told, and its strict JSON schema.</summary>
public sealed record FunctionToolSpec(string Name, string Description, string ParametersJson);

/// <summary>
/// One function tool MedAssist can call (Strategy). Each tool is its own class, so adding one means adding a class
/// and registering it, without changing the others or the loops that call them.
/// </summary>
public interface IClinicTool
{
    FunctionToolSpec Spec { get; }

    /// <summary>Runs the tool for the session's patient. Arguments that do not fit the schema are a
    /// <see cref="ToolError"/> the model can read, never an exception.</summary>
    ToolResult Invoke(PatientSession session, JsonElement arguments);
}

/// <summary>
/// The shared shape of a tool (Template Method): read the model's arguments into a typed request, then run it.
/// Missing or mistyped arguments become a <see cref="ToolError"/>.
/// </summary>
public abstract class ClinicTool<TRequest> : IClinicTool
{
    private static readonly JsonSerializerOptions Arguments = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        RespectRequiredConstructorParameters = true,  // a missing argument is an error, not a default
        RespectNullableAnnotations = true,
    };

    public abstract FunctionToolSpec Spec { get; }

    public ToolResult Invoke(PatientSession session, JsonElement arguments)
    {
        TRequest? request;
        try
        {
            request = arguments.Deserialize<TRequest>(Arguments);
        }
        catch (JsonException exc)
        {
            return new ToolError($"Bad arguments for {Spec.Name}: {exc.Message}");
        }
        return request is null ? new ToolError($"Bad arguments for {Spec.Name}: none given") : Run(session, request);
    }

    protected abstract ToolResult Run(PatientSession session, TRequest request);
}

/// <summary>get_my_record takes no arguments.</summary>
public sealed record NoArguments;

public sealed class GetMyRecordTool : ClinicTool<NoArguments>
{
    public override FunctionToolSpec Spec { get; } = new(
        "get_my_record",
        "The signed-in patient's record: name, date of birth, registered GP, allergies, conditions, medicines and " +
        "upcoming appointments. Only ever the signed-in patient's own record.",
        """{"type": "object", "properties": {}, "required": [], "additionalProperties": false}""");

    protected override ToolResult Run(PatientSession session, NoArguments request) => session.GetMyRecord();
}

public sealed class FindAppointmentsTool : ClinicTool<FindAppointmentsRequest>
{
    public override FunctionToolSpec Spec { get; } = new(
        "find_appointments",
        "Free appointments, earliest first, up to six. Offer only slots this returns; never make up a time.",
        """
        {
          "type": "object",
          "properties": {
            "appointment_type": {"type": "string", "enum": ["gp", "phone", "nurse", "pharmacist"],
                                 "description": "gp (face to face), phone (GP phone call), nurse (blood tests, vaccinations, dressings, asthma reviews), pharmacist (medicines)"},
            "clinician": {"type": "string", "description": "part of a clinician's name, e.g. Azevedo; empty for anyone"},
            "earliest_date": {"type": "string", "description": "YYYY-MM-DD; today if the patient has no preference"},
            "time_of_day": {"type": "string", "enum": ["any", "morning", "afternoon"]}
          },
          "required": ["appointment_type", "clinician", "earliest_date", "time_of_day"],
          "additionalProperties": false
        }
        """);

    protected override ToolResult Run(PatientSession session, FindAppointmentsRequest request) =>
        session.FindAppointments(request);
}

public sealed class BookAppointmentTool : ClinicTool<BookAppointmentRequest>
{
    public override FunctionToolSpec Spec { get; } = new(
        "book_appointment",
        "Book a slot that find_appointments offered, for the signed-in patient, once they have chosen it. " +
        "Texts them a confirmation.",
        """
        {
          "type": "object",
          "properties": {"slot_id": {"type": "string"},
                         "reason": {"type": "string", "description": "a few words, in the patient's own words"}},
          "required": ["slot_id", "reason"],
          "additionalProperties": false
        }
        """);

    protected override ToolResult Run(PatientSession session, BookAppointmentRequest request) =>
        session.BookAppointment(request);
}

public sealed class CancelAppointmentTool : ClinicTool<CancelAppointmentRequest>
{
    public override FunctionToolSpec Spec { get; } = new(
        "cancel_appointment",
        "Cancel one of the signed-in patient's upcoming appointments, after they have confirmed which one. " +
        "Texts them a confirmation.",
        """
        {"type": "object", "properties": {"appointment_id": {"type": "string"}},
         "required": ["appointment_id"], "additionalProperties": false}
        """);

    protected override ToolResult Run(PatientSession session, CancelAppointmentRequest request) =>
        session.CancelAppointment(request);
}

/// <summary>
/// The tools MedAssist has, by name (Registry). Both agent loops call tools through this, so a tool the model makes
/// up, or arguments that are not JSON, get the same answer whichever loop is running.
/// </summary>
public sealed class ClinicToolbox(IEnumerable<IClinicTool> tools)
{
    private readonly Dictionary<string, IClinicTool> _tools = tools.ToDictionary(t => t.Spec.Name);

    /// <summary>The four tools, in a stable order, for the agent's definition.</summary>
    public IReadOnlyList<FunctionToolSpec> Specs => [.. _tools.Values.Select(t => t.Spec)];

    /// <summary>The standard four.</summary>
    public static ClinicToolbox Standard() =>
        new([new GetMyRecordTool(), new FindAppointmentsTool(), new BookAppointmentTool(), new CancelAppointmentTool()]);

    public ToolResult Call(PatientSession session, string name, string argumentsJson)
    {
        if (!_tools.TryGetValue(name, out var tool))
        {
            return new ToolError($"There is no tool called {name}.");
        }
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(string.IsNullOrWhiteSpace(argumentsJson) ? "{}" : argumentsJson);
        }
        catch (JsonException)
        {
            return new ToolError("The arguments were not valid JSON.");
        }
        using (document)
        {
            return tool.Invoke(session, document.RootElement);
        }
    }
}
