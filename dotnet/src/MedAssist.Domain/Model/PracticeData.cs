namespace MedAssist.Domain;

/// <summary>One patient of the practice. All invented; 07700 900xxx numbers are reserved by Ofcom for drama.</summary>
public sealed record Patient(string Id, string Name, string DateOfBirth, string Phone, string RegisteredGp,
                             string Allergies, string Conditions, string Medications)
{
    /// <summary>Age in whole years on <paramref name="today"/>.</summary>
    public int AgeOn(DateOnly today)
    {
        var born = DateOnly.ParseExact(DateOfBirth, "yyyy-MM-dd");
        return today.Year - born.Year - ((today.Month, today.Day).CompareTo((born.Month, born.Day)) < 0 ? 1 : 0);
    }
}

/// <summary>One clinician, and their weekly diary: (time, kind) for each weekday, Monday 0.</summary>
public sealed record Clinician(string Id, string Name, string Role, IReadOnlyDictionary<int, (string Time, string Kind)[]> Week);

/// <summary>
/// The practice's fixed data: clinicians and their diaries, patients, and the appointment types. The same as
/// examples/medassist/clinic.py, so the Python and .NET versions can share one database file.
/// </summary>
public static class PracticeData
{
    public const int WeeksAhead = 4;

    private static readonly string[] Face = ["09:00", "09:40", "10:00", "10:40", "11:20", "14:30", "15:30"];

    public static readonly IReadOnlyList<Clinician> Clinicians =
    [
        new("AZE", "Dr Ana Azevedo", "gp", Days([0, 2, 3], GpDay())),
        new("OKA", "Dr Tom Okafor", "gp",
            new Dictionary<int, (string, string)[]>(Days([0, 1, 4], GpDay()))
            {
                [5] = [("09:30", "face_to_face"), ("10:30", "face_to_face")],
            }),
        // Mornings only: blood samples are collected at 13:00.
        new("SHA", "Nurse Priya Shah", "nurse",
            new Dictionary<int, (string, string)[]>(
                Days([0, 1, 2, 3, 4], [.. new[] { "08:20", "09:10", "10:30", "11:40" }.Select(t => (t, "face_to_face"))]))
            {
                [5] = [("10:15", "face_to_face")],
            }),
        new("LEW", "Ben Lewis (clinical pharmacist)", "pharmacist",
            Days([1, 3], [("13:30", "face_to_face"), ("15:00", "face_to_face")])),
    ];

    public static readonly IReadOnlyList<Patient> Patients =
    [
        new("P001", "Valeria Romano", "1986-05-14", "07403289357", "AZE", "Penicillin", "Asthma",
            "Salbutamol inhaler; beclometasone inhaler"),
        new("P002", "Sam Taylor", "1980-03-03", "07700 900456", "OKA", "None known", "High blood pressure", "Lisinopril 10 mg"),
        new("P003", "Margaret Ellis", "1941-11-20", "07700 900789", "AZE", "None known", "Type 2 diabetes", "Metformin"),
        new("P004", "Lucía García", "2001-07-09", "07700 900211", "OKA", "None known", "None", "None"),
        new("P005", "Agnieszka Nowak", "1990-02-21", "07700 900212", "AZE", "Latex", "Migraine", "Sumatriptan 50 mg when needed"),
        new("P006", "Fatima Al-Sayed", "1972-10-30", "07700 900213", "OKA", "None known", "Hypothyroidism",
            "Levothyroxine 100 micrograms"),
        new("P007", "Andrei Ionescu", "1958-05-02", "07700 900214", "AZE", "None known", "High cholesterol", "Atorvastatin 20 mg"),
        new("P008", "Imran Hussain", "1947-01-15", "07700 900215", "OKA", "Aspirin", "Type 2 diabetes; high blood pressure",
            "Metformin 500 mg; amlodipine 5 mg"),
        new("P009", "Harpreet Kaur", "1939-08-26", "07700 900216", "AZE", "None known", "Osteoarthritis; atrial fibrillation",
            "Paracetamol 1 g when needed; apixaban 2.5 mg"),
    ];

    /// <summary>The language each patient prefers for texts (python/translator.py's codes). English unless stated.</summary>
    public static readonly IReadOnlyDictionary<string, string> PreferredLanguage = new Dictionary<string, string>
    {
        ["P001"] = "en", ["P002"] = "en", ["P003"] = "en", ["P004"] = "es", ["P005"] = "pl", ["P006"] = "ar",
        ["P007"] = "ro", ["P008"] = "ur", ["P009"] = "pa",
    };

    /// <summary>The names the lab's page shows for those codes.</summary>
    public static readonly IReadOnlyDictionary<string, string> LanguageNames = new Dictionary<string, string>
    {
        ["en"] = "English", ["es"] = "Spanish", ["pl"] = "Polish", ["ar"] = "Arabic", ["ro"] = "Romanian",
        ["ur"] = "Urdu", ["pa"] = "Punjabi",
    };

    /// <summary>appointment_type -> (clinician role, slot kind).</summary>
    public static readonly IReadOnlyDictionary<string, (string Role, string Kind)> AppointmentTypes =
        new Dictionary<string, (string, string)>
        {
            ["gp"] = ("gp", "face_to_face"), ["phone"] = ("gp", "phone"), ["nurse"] = ("nurse", "face_to_face"),
            ["pharmacist"] = ("pharmacist", "face_to_face"),
        };

    public static Patient? FindPatient(string id) => Patients.FirstOrDefault(p => p.Id == id);

    private static (string, string)[] GpDay() =>
        [.. Face.Select(t => (t, "face_to_face")), ("12:00", "phone"), ("12:20", "phone")];

    private static Dictionary<int, (string, string)[]> Days(int[] days, (string, string)[] times) =>
        days.ToDictionary(d => d, _ => times);
}
