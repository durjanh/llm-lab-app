using System.Security.Cryptography;
using System.Text;
using MedAssist.Data;
using MedAssist.Domain;

namespace MedAssist.Data.Tests;

/// <summary>The SQLite data layer: the same database as the Python version, and the queries the rules rely on.</summary>
public class SqlitePracticeRepositoryTests
{
    private static readonly DateOnly Monday = new(2026, 11, 9);
    private string _path = "";

    [SetUp]
    public void FreshDatabase()
    {
        _path = Path.Combine(Path.GetTempPath(), $"medassist-{Guid.NewGuid():N}.db");
        new SqlitePracticeStore(_path).Recreate(Monday, new DateTime(2026, 11, 9, 8, 0, 0));
    }

    [TearDown]
    public void RemoveDatabase() => File.Delete(_path);

    [Test]
    public void The_database_is_the_one_the_python_version_makes_for_the_same_day()
    {
        // From examples/medassist/clinic.py, create_database(today=date(2026, 11, 9)): the same slots, the same ones
        // already taken by other patients, and Valeria's asthma review in the same place.
        using var db = PracticeSchema.Open(_path);
        using var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT id, clinician_id, starts_at, kind, ifnull(patient_id, ''), ifnull(reason, '') FROM slots ORDER BY id";
        var lines = new List<string>();
        using (var r = cmd.ExecuteReader())
        {
            while (r.Read())
            {
                lines.Add(string.Join("|", Enumerable.Range(0, 6).Select(r.GetString)));
            }
        }

        lines.Should().HaveCount(346);
        lines.Count(l => l.Split('|')[4] == "other").Should().Be(123);
        lines.Should().Contain("SHA-20261119-0910|SHA|2026-11-19T09:10|face_to_face|P001|Annual asthma review");
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("\n", lines))))
               .Should().Be("5337d687524df658845451d40a7bfbf6b13f8d7f919c2fb21a5f38a6ab00dcf2");
    }

    [Test]
    public void Free_slots_are_filtered_by_role_clinician_and_time_of_day_earliest_first()
    {
        using var practice = new SqlitePracticeRepository(_path);
        var slots = practice.FindFreeSlots(new FreeSlotQuery("gp", "face_to_face", "2026-11-09T08:00", "2026-11-09T08:00", "Okafor", "afternoon"));

        slots.Should().NotBeEmpty().And.HaveCountLessThanOrEqualTo(6);
        slots.Should().AllSatisfy(s =>
        {
            s.Clinician.Should().Be("Dr Tom Okafor");
            string.CompareOrdinal(s.StartsAt[11..16], "12:00").Should().BeGreaterThanOrEqualTo(0);
        });
        slots.Select(s => s.StartsAt).Should().BeInAscendingOrder(StringComparer.Ordinal);
    }

    [Test]
    public void A_slot_is_claimed_once_only()
    {
        using var practice = new SqlitePracticeRepository(_path);
        var slot = practice.FindFreeSlots(new FreeSlotQuery("gp", "face_to_face", "2026-11-09T08:00", "2026-11-09T08:00", "", "any"))[0];

        practice.TryClaimSlot(slot.SlotId, "P002", "review", "2026-11-09T08:01:00").Should().BeTrue();
        practice.TryClaimSlot(slot.SlotId, "P003", "review", "2026-11-09T08:01:01").Should().BeFalse();
        practice.UpcomingFor("P002", "2026-11-09T08:00").Select(s => s.SlotId).Should().Contain(slot.SlotId);
    }

    [Test]
    public void A_patient_changed_in_the_code_is_changed_in_the_database_and_bookings_stay()
    {
        string booked;
        using (var practice = new SqlitePracticeRepository(_path))
        {
            booked = practice.FindFreeSlots(new FreeSlotQuery("gp", "face_to_face", "2026-11-10T00:00", "2026-11-10T00:00", "", "any"))[0].SlotId;
            practice.TryClaimSlot(booked, "P002", "review", "2026-11-09T08:01:00");
        }
        using (var db = PracticeSchema.Open(_path))
        using (var cmd = db.CreateCommand())  // as if made when Valeria had another number
        {
            cmd.CommandText = "UPDATE patients SET phone = '07700 900123', allergies = 'None known' WHERE id = 'P001'";
            cmd.ExecuteNonQuery();
        }

        using var reopened = new SqlitePracticeRepository(_path);
        var valeria = PracticeData.Patients.Single(p => p.Id == "P001");
        reopened.FindPatient("P001").Should().Be(valeria, "opening the database syncs it with the code");
        reopened.UpcomingFor("P002", "2026-11-09T08:00").Select(s => s.SlotId).Should().Contain(booked, "bookings stay");
    }

    [Test]
    public void A_database_already_in_step_is_not_written_to()
    {
        using var db = PracticeSchema.Open(_path);
        using var changes = db.CreateCommand();
        changes.CommandText = "SELECT total_changes()";
        var before = Convert.ToInt64(changes.ExecuteScalar());

        PracticeSchema.SyncPatients(db);

        Convert.ToInt64(changes.ExecuteScalar()).Should().Be(before);
    }

    [Test]
    public void An_older_database_gains_patients_added_since_and_the_calls_table()
    {
        using (var db = PracticeSchema.Open(_path))
        using (var cmd = db.CreateCommand())
        {
            cmd.CommandText = "DELETE FROM patients WHERE id = 'P009'; DROP TABLE calls;";
            cmd.ExecuteNonQuery();
        }

        using var practice = new SqlitePracticeRepository(_path);
        practice.FindPatient("P009")!.Name.Should().Be("Harpreet Kaur");
        practice.CallsFor("P009", 10).Should().BeEmpty();
    }
}
