using System.Globalization;

namespace MedAssist.Domain;

/// <summary>
/// How the practice writes times. Slot times are local ISO strings to the minute ("2026-11-12T09:40"), as
/// clinic.py writes them, so they compare in time order as plain strings.
/// </summary>
public static class PracticeCalendar
{
    /// <summary>"2026-11-12T09:40" as the patient hears it: "Thursday 12 November at 09:40".</summary>
    public static string Spoken(string startsAt) =>
        DateTime.ParseExact(startsAt, "yyyy-MM-dd'T'HH:mm", CultureInfo.InvariantCulture)
                .ToString("dddd d MMMM 'at' HH:mm", CultureInfo.InvariantCulture);

    /// <summary>Python's isoformat(timespec="minutes").</summary>
    public static string Minutes(DateTime t) => t.ToString("yyyy-MM-dd'T'HH:mm", CultureInfo.InvariantCulture);

    /// <summary>Python's isoformat(timespec="seconds"), for the audit log and texts.</summary>
    public static string Stamp(DateTime t) => t.ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture);

    public static string Day(DateOnly d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>Monday 0, as Python's weekday() counts.</summary>
    public static int Weekday(DateOnly day) => ((int)day.DayOfWeek + 6) % 7;

    /// <summary>The practice's local time now.</summary>
    public static DateTime Now(this TimeProvider time) => time.GetLocalNow().DateTime;

    public static DateOnly Today(this TimeProvider time) => DateOnly.FromDateTime(time.Now());
}
