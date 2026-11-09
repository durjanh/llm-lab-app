using MedAssist.Domain;
using Microsoft.Extensions.Options;

namespace MedAssist.Application;

/// <summary>The kinds of failure the services report. The API maps each to an HTTP status; the CLI prints the message.</summary>
public enum FailureKind
{
    InvalidRequest,
    NotFound,
    Busy,
    BudgetExceeded,
    NotConfigured,
    Upstream,
}

/// <summary>A failure the person can act on, with a message that says how.</summary>
public sealed class ServiceException(FailureKind kind, string message, Exception? inner = null) : Exception(message, inner)
{
    public FailureKind Kind { get; } = kind;
}

/// <summary>What a failure means for the person: its kind and a message to show.</summary>
public sealed record Failure(FailureKind Kind, string Type, string Message);

/// <summary>
/// Turns an exception from one layer into a <see cref="Failure"/> (Chain of Responsibility): each classifier
/// knows its own layer's exceptions, and returns null for the rest. The API and the CLI both report through these.
/// </summary>
public interface IFailureClassifier
{
    Failure? Classify(Exception exception);
}

/// <summary>The service layer's own failures, bad settings and unknown patients.</summary>
public sealed class ServiceFailureClassifier : IFailureClassifier
{
    public Failure? Classify(Exception exception) => exception switch
    {
        ServiceException s => new Failure(s.Kind, TypeOf(s.Kind), s.Message),
        PatientNotFoundException p => new Failure(FailureKind.InvalidRequest, "invalid_request",
            $"patient_id: choose one of {string.Join(", ", PracticeData.Patients.Select(x => x.Id))} (not {p.PatientId})"),
        OptionsValidationException o => new Failure(FailureKind.NotConfigured, "not_configured", string.Join(" ", o.Failures)),
        _ => null,
    };

    public static string TypeOf(FailureKind kind) => kind switch
    {
        FailureKind.InvalidRequest => "invalid_request",
        FailureKind.NotFound => "not_found",
        FailureKind.Busy => "busy",
        FailureKind.BudgetExceeded => "budget_exceeded",
        FailureKind.NotConfigured => "not_configured",
        _ => "upstream_error",
    };
}

/// <summary>Asks each classifier in turn; anything none of them knows is unexpected, and reported as such.</summary>
public sealed class FailureReporter(IEnumerable<IFailureClassifier> classifiers)
{
    public Failure Classify(Exception exception) =>
        classifiers.Select(c => c.Classify(exception)).FirstOrDefault(f => f is not null)
        ?? new Failure(FailureKind.Upstream, "server_error", $"Something went wrong: {exception.Message}");
}
