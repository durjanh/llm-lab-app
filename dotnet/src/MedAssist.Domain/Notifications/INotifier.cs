namespace MedAssist.Domain;

/// <summary>
/// Real texts and reminders, when the practice sends them (examples/medassist/sms.py does this through Azure
/// Communication Services). Each method returns what to write to the audit log, or null for nothing.
/// </summary>
public interface INotifier
{
    string? Send(string patient, string body, string language);

    string? Schedule(string appointmentId, string patient, string body, string startsAt, string language);

    string? Cancel(string appointmentId);
}

/// <summary>No real texts: they stay rows in the messages table, and nothing is audited for them (Null Object).</summary>
public sealed class NullNotifier : INotifier
{
    public static readonly NullNotifier Instance = new();

    public string? Send(string patient, string body, string language) => null;

    public string? Schedule(string appointmentId, string patient, string body, string startsAt, string language) => null;

    public string? Cancel(string appointmentId) => null;
}
