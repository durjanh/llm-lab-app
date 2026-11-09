using System.Text.Json;
using MedAssist.Application;

namespace MedAssist.Api.Contracts;

/// <summary>The service layer's results as the page's JSON. Pure functions: tested without a server.</summary>
public static class ApiMapper
{
    public static InfoResponse ToResponse(this MedAssistInfo info) => new(
        info.Status.Ready, info.Status.Configured, RealTexts: false, info.Status.Model, MedAssistAgent.Name, info.Status.Version,
        info.Status.Problem, info.Engine, [.. info.Patients.Select(p => new PatientDto(p.Id, p.Name, p.Age, p.Language))]);

    public static PracticeStateDto ToResponse(this PracticeRecords r) => new(
        new PatientRecordDto(r.Patient.Id, r.Patient.Name, r.Patient.DateOfBirth, r.Patient.Phone, r.RegisteredGp, r.Patient.Allergies,
                             r.Patient.Conditions, r.Patient.Medications),
        [.. r.Upcoming.Select(a => new AppointmentDto(a.AppointmentId, a.With, a.When, a.Kind, a.Reason))],
        [.. r.Texts.Select(t => new TextDto(t.SentAt, t.SentTo, t.Body))],
        [.. r.Audit.Select(a => new AuditDto(a.At, a.Actor, a.Action, a.Detail))],
        [.. r.Calls.Select(c => new CallDto(c.At, c.CallId, c.Speaker, c.Text))]);

    public static ChatStartedResponse ToResponse(this ChatStarted started) => new(started.ChatId, started.State.ToResponse());

    public static ChatReplyResponse ToResponse(this ChatReply reply) =>
        new(reply.Reply, [.. reply.Steps.Select(ToDto)], reply.CostUsd, reply.TotalUsd, reply.State.ToResponse());

    public static StepDto ToDto(Step step) => step switch
    {
        FileSearchStep s => new StepDto(s.Tool, Queries: s.Queries),
        CodeInterpreterStep c => new StepDto(c.Tool, Code: c.Code),
        FunctionStep f => new StepDto(f.Tool, Args: Json(f.ArgumentsJson), Result: Json(f.Result.ToJson())),
        _ => new StepDto(step.Tool),
    };

    /// <summary>The model's arguments as JSON when they are JSON; as a string otherwise, as the Python page shows them.</summary>
    private static JsonElement Json(string text)
    {
        try
        {
            using var document = JsonDocument.Parse(text);
            return document.RootElement.Clone();
        }
        catch (JsonException)
        {
            return JsonSerializer.SerializeToElement(text);
        }
    }
}
