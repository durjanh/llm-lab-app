using System.Security.Cryptography;
using System.Text;
using MedAssist.Domain;
using Microsoft.Data.Sqlite;

namespace MedAssist.Data;

/// <summary>
/// The practice database's schema and its seed: clinicians, patients, four weeks of diaries from a given day, and
/// one existing appointment. The same schema and data as clinic.create_database, slot for slot.
/// </summary>
public static class PracticeSchema
{
    /// <summary>Phone calls to the practice line (the Python backend writes them); made here so a shared database has it.</summary>
    public const string Calls = """
        CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY, patient_id TEXT, call_id TEXT, at TEXT,
                                          speaker TEXT, text TEXT);
        """;

    private const string Tables = """
        CREATE TABLE clinicians (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL);
        CREATE TABLE patients (id TEXT PRIMARY KEY, name TEXT NOT NULL, date_of_birth TEXT NOT NULL, phone TEXT NOT NULL,
            registered_gp TEXT REFERENCES clinicians(id), allergies TEXT, conditions TEXT, medications TEXT);
        -- One row per slot in a clinician's diary. patient_id NULL means free; 'other' means another patient has it.
        CREATE TABLE slots (id TEXT PRIMARY KEY, clinician_id TEXT NOT NULL REFERENCES clinicians(id),
            starts_at TEXT NOT NULL, kind TEXT NOT NULL, patient_id TEXT, reason TEXT, booked_at TEXT);
        CREATE TABLE messages (id INTEGER PRIMARY KEY, patient_id TEXT, sent_to TEXT, body TEXT, sent_at TEXT);
        CREATE TABLE audit (id INTEGER PRIMARY KEY, at TEXT, patient_id TEXT, actor TEXT, action TEXT, detail TEXT);
        """;

    /// <summary>A connection to the practice database. Pooling is off, so a rebuilt file is never shadowed by a
    /// pooled connection to the old one.</summary>
    public static SqliteConnection Open(string path)
    {
        var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString());
        db.Open();
        return db;
    }

    /// <summary>About a third of slots are already booked by other patients: the same ones for the same day, in both
    /// versions (the first byte of the slot id's SHA-256, as clinic.py does it).</summary>
    public static bool OtherPatientHas(string slotId) => SHA256.HashData(Encoding.UTF8.GetBytes(slotId))[0] < 85;

    /// <summary>A fresh database at <paramref name="path"/>, replacing any there. <paramref name="now"/> stamps the
    /// existing appointment's booking time.</summary>
    public static void Create(string path, DateOnly today, DateTime now)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        File.Delete(path);
        using var db = Open(path);
        using var tx = db.BeginTransaction();
        Execute(db, Tables + Calls);
        foreach (var c in PracticeData.Clinicians)
        {
            Execute(db, "INSERT INTO clinicians VALUES ($id, $name, $role)", ("$id", c.Id), ("$name", c.Name), ("$role", c.Role));
        }
        SyncPatients(db);
        foreach (var c in PracticeData.Clinicians)
        {
            for (var n = 0; n <= PracticeData.WeeksAhead * 7; n++)
            {
                var day = today.AddDays(n);
                if (!c.Week.TryGetValue(PracticeCalendar.Weekday(day), out var times))
                {
                    continue;
                }
                foreach (var (time, kind) in times)
                {
                    var slotId = $"{c.Id}-{day:yyyyMMdd}-{time.Replace(":", "")}";
                    Execute(db, "INSERT INTO slots (id, clinician_id, starts_at, kind, patient_id) VALUES ($id, $c, $at, $kind, $p)",
                            ("$id", slotId), ("$c", c.Id), ("$at", $"{PracticeCalendar.Day(day)}T{time}"), ("$kind", kind),
                            ("$p", OtherPatientHas(slotId) ? "other" : null));
                }
            }
        }
        // Valeria already has an asthma review with the nurse in about ten days.
        Execute(db, """
            UPDATE slots SET patient_id = 'P001', reason = 'Annual asthma review', booked_at = $now
            WHERE id = (SELECT id FROM slots WHERE clinician_id = 'SHA' AND patient_id IS NULL
                        AND starts_at >= $from ORDER BY starts_at LIMIT 1)
            """, ("$now", PracticeCalendar.Stamp(now)), ("$from", PracticeCalendar.Day(today.AddDays(10))));
        tx.Commit();
    }

    /// <summary>
    /// The database's patients as <see cref="PracticeData.Patients"/> has them: new ones added, changed details
    /// updated. The code is the only source of patient details, so editing a patient there (a new phone number, say)
    /// needs no reset and loses no bookings. A row is written only when something in it has changed. The same SQL as
    /// clinic.sync_patients.
    /// </summary>
    public static void SyncPatients(SqliteConnection db)
    {
        foreach (var p in PracticeData.Patients)
        {
            Execute(db, """
                INSERT INTO patients (id, name, date_of_birth, phone, registered_gp, allergies, conditions, medications)
                VALUES ($id, $name, $dob, $phone, $gp, $al, $co, $me)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name, date_of_birth = excluded.date_of_birth, phone = excluded.phone,
                    registered_gp = excluded.registered_gp, allergies = excluded.allergies, conditions = excluded.conditions,
                    medications = excluded.medications
                WHERE patients.name IS NOT excluded.name OR patients.date_of_birth IS NOT excluded.date_of_birth
                   OR patients.phone IS NOT excluded.phone OR patients.registered_gp IS NOT excluded.registered_gp
                   OR patients.allergies IS NOT excluded.allergies OR patients.conditions IS NOT excluded.conditions
                   OR patients.medications IS NOT excluded.medications
                """,
                ("$id", p.Id), ("$name", p.Name), ("$dob", p.DateOfBirth), ("$phone", p.Phone), ("$gp", p.RegisteredGp),
                ("$al", p.Allergies), ("$co", p.Conditions), ("$me", p.Medications));
        }
    }

    private static void Execute(SqliteConnection db, string sql, params (string Name, object? Value)[] values)
    {
        using var cmd = db.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (name, value) in values)
        {
            cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        }
        cmd.ExecuteNonQuery();
    }
}
