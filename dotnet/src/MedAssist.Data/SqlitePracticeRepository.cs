using MedAssist.Domain;
using Microsoft.Data.Sqlite;

namespace MedAssist.Data;

/// <summary>
/// <see cref="IPracticeRepository"/> on the SQLite file clinic.py makes. Opening it brings an older database up to
/// date: the calls table, and the patients as <see cref="PracticeData.Patients"/> has them now, added or changed.
/// </summary>
public sealed class SqlitePracticeRepository : IPracticeRepository
{
    private readonly SqliteConnection _db;

    public SqlitePracticeRepository(string path)
    {
        _db = PracticeSchema.Open(path);
        Execute(PracticeSchema.Calls);
        PracticeSchema.SyncPatients(_db);
    }

    public Patient? FindPatient(string patientId) => Rows(
        "SELECT id, name, date_of_birth, phone, registered_gp, allergies, conditions, medications FROM patients WHERE id = $id",
        r => new Patient(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetString(5),
                         r.GetString(6), r.GetString(7)),
        ("$id", patientId)).FirstOrDefault();

    public string? ClinicianName(string clinicianId) =>
        Rows("SELECT name FROM clinicians WHERE id = $id", r => r.GetString(0), ("$id", clinicianId)).FirstOrDefault();

    public IReadOnlyList<FreeSlot> FindFreeSlots(FreeSlotQuery q)
    {
        var sql = """
            SELECT s.id, s.starts_at, c.name FROM slots s JOIN clinicians c ON c.id = s.clinician_id
            WHERE c.role = $role AND s.kind = $kind AND s.patient_id IS NULL AND s.starts_at > $after AND s.starts_at >= $from
            """;
        var values = new List<(string, object?)> { ("$role", q.Role), ("$kind", q.Kind), ("$after", q.After), ("$from", q.From) };
        if (q.ClinicianLike.Length > 0)
        {
            sql += " AND c.name LIKE $clinician";
            values.Add(("$clinician", $"%{q.ClinicianLike}%"));
        }
        sql += q.TimeOfDay switch
        {
            "morning" => " AND substr(s.starts_at, 12, 5) < '12:00'",
            "afternoon" => " AND substr(s.starts_at, 12, 5) >= '12:00'",
            _ => "",
        };
        values.Add(("$limit", q.Limit));
        return Rows(sql + " ORDER BY s.starts_at LIMIT $limit", r => new FreeSlot(r.GetString(0), r.GetString(1), r.GetString(2)),
                    [.. values]);
    }

    public SlotDetails? FindSlot(string slotId) => Rows(
        "SELECT s.id, s.starts_at, s.kind, c.name FROM slots s JOIN clinicians c ON c.id = s.clinician_id WHERE s.id = $id",
        r => new SlotDetails(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3)), ("$id", slotId)).FirstOrDefault();

    public bool TryClaimSlot(string slotId, string patientId, string reason, string bookedAt) =>
        Execute("UPDATE slots SET patient_id = $p, reason = $r, booked_at = $at WHERE id = $id AND patient_id IS NULL",
                ("$p", patientId), ("$r", reason), ("$at", bookedAt), ("$id", slotId)) == 1;

    public void ReleaseSlot(string slotId) =>
        Execute("UPDATE slots SET patient_id = NULL, reason = NULL, booked_at = NULL WHERE id = $id", ("$id", slotId));

    public IReadOnlyList<BookedSlot> UpcomingFor(string patientId, string after) => Rows("""
        SELECT s.id, s.starts_at, s.kind, s.reason, c.name FROM slots s JOIN clinicians c ON c.id = s.clinician_id
        WHERE s.patient_id = $p AND s.starts_at > $after ORDER BY s.starts_at
        """, r => new BookedSlot(r.GetString(0), r.GetString(1), r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3), r.GetString(4)),
        ("$p", patientId), ("$after", after));

    public void AddText(string patientId, string sentTo, string body, string sentAt) =>
        Execute("INSERT INTO messages (patient_id, sent_to, body, sent_at) VALUES ($p, $to, $b, $at)",
                ("$p", patientId), ("$to", sentTo), ("$b", body), ("$at", sentAt));

    public void AddAudit(string patientId, string action, string detail, string at) =>
        Execute("INSERT INTO audit (at, patient_id, actor, action, detail) VALUES ($at, $p, 'MedAssist', $a, $d)",
                ("$at", at), ("$p", patientId), ("$a", action), ("$d", detail));

    public IReadOnlyList<SentText> TextsFor(string patientId, int limit) => Rows(
        "SELECT sent_at, sent_to, body FROM messages WHERE patient_id = $p ORDER BY id DESC LIMIT $n",
        r => new SentText(r.GetString(0), r.GetString(1), r.GetString(2)), ("$p", patientId), ("$n", limit));

    public IReadOnlyList<AuditEntry> AuditFor(string patientId, int limit) => Rows(
        "SELECT at, actor, action, detail FROM audit WHERE patient_id = $p ORDER BY id DESC LIMIT $n",
        r => new AuditEntry(r.GetString(0), r.GetString(1), r.GetString(2), r.IsDBNull(3) ? "" : r.GetString(3)),
        ("$p", patientId), ("$n", limit));

    public IReadOnlyList<CallLine> CallsFor(string patientId, int limit) => [.. Rows(
        "SELECT at, call_id, speaker, text FROM calls WHERE patient_id = $p ORDER BY id DESC LIMIT $n",
        r => new CallLine(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3)),
        ("$p", patientId), ("$n", limit)).AsEnumerable().Reverse()];  // oldest line first

    public int CountTexts() => Count("SELECT count(*) FROM messages");

    public int CountBookings(string slotPrefix) =>
        Count("SELECT count(*) FROM audit WHERE action = 'appointment booked' AND detail LIKE $c", ("$c", $"{slotPrefix}%"));

    public void Dispose() => _db.Dispose();

    private int Count(string sql, params (string, object?)[] values)
    {
        using var cmd = Command(sql, values);
        return Convert.ToInt32(cmd.ExecuteScalar());
    }

    private int Execute(string sql, params (string, object?)[] values)
    {
        using var cmd = Command(sql, values);
        return cmd.ExecuteNonQuery();
    }

    private List<T> Rows<T>(string sql, Func<SqliteDataReader, T> read, params (string, object?)[] values)
    {
        using var cmd = Command(sql, values);
        using var reader = cmd.ExecuteReader();
        var rows = new List<T>();
        while (reader.Read())
        {
            rows.Add(read(reader));
        }
        return rows;
    }

    private SqliteCommand Command(string sql, (string Name, object? Value)[] values)
    {
        var cmd = _db.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (name, value) in values)
        {
            cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        }
        return cmd;
    }
}
