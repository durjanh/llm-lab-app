using System.ComponentModel.DataAnnotations;
using System.Text.Json;

namespace MedAssist.Api.Contracts;

// The JSON the lab's page reads (frontend/src/services/medassistService.ts), written with snake_case names, as
// the Python backend sends it. Kept apart from the service layer's types, so either can change without the other.

public sealed record StartChatRequest([Required] string PatientId);

public sealed record SendMessageRequest([Required] string Message);

public sealed record PatientDto(string Id, string Name, int Age, string Language);

public sealed record InfoResponse(bool Ready, bool Configured, bool RealTexts, string? Model, string Agent, string? Version,
                                  string Problem, string Engine, IReadOnlyList<PatientDto> Patients);

public sealed record PatientRecordDto(string Id, string Name, string DateOfBirth, string Phone, string? RegisteredGp,
                                      string Allergies, string Conditions, string Medications);

public sealed record AppointmentDto(string AppointmentId, string With, string When, string Kind, string? Reason);

public sealed record TextDto(string SentAt, string SentTo, string Body);

public sealed record AuditDto(string At, string Actor, string Action, string Detail);

public sealed record CallDto(string At, string CallId, string Speaker, string Text);

public sealed record PracticeStateDto(PatientRecordDto Patient, IReadOnlyList<AppointmentDto> Upcoming, IReadOnlyList<TextDto> Texts,
                                      IReadOnlyList<AuditDto> Audit, IReadOnlyList<CallDto> Calls);

/// <summary>One step: {tool, queries} for File Search, {tool, code} for the Code Interpreter, {tool, args, result}
/// for a function tool.</summary>
public sealed record StepDto(string Tool, IReadOnlyList<string>? Queries = null, string? Code = null, JsonElement? Args = null,
                             JsonElement? Result = null);

public sealed record ChatStartedResponse(string ChatId, PracticeStateDto State);

public sealed record ChatReplyResponse(string Reply, IReadOnlyList<StepDto> Steps, decimal CostUsd, decimal TotalUsd,
                                       PracticeStateDto State);

public sealed record ChatEndedResponse(bool Ended);

/// <summary>As the Python backend answers, with where the old database was kept.</summary>
public sealed record ResetResponse(bool Reset, int Weeks, string? KeptCopy);

public sealed record PhoneLineResponse(bool Configured, IReadOnlyList<string> Missing, string Patient);

public sealed record ErrorBody(string Type, string Message);

/// <summary>Every error, as the Python backend writes it: {"error": {"type", "message"}}.</summary>
public sealed record ErrorResponse(ErrorBody Error);
