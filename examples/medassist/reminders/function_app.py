"""MedAssist's appointment reminders: every 15 minutes, sends the reminders that are due and deletes them.

A booking adds a row to the reminders table (examples/medassist/sms.py) with the text, the number and when to send it:
24 hours before the appointment, in UTC. Cancelling deletes the row, so a cancelled appointment is never reminded. A
row is deleted only once Communication Services has accepted its text, so a failed send is tried again next time.

Signed in with the Function's managed identity: Storage Table Data Contributor on the table, and the Communication
Services role on the resource that sends. No keys. On the Flex Consumption plan it costs nothing while idle; these
runs, about 2,900 a month, are inside the monthly free grant.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone

import azure.functions as func
from azure.communication.sms import SmsClient
from azure.data.tables import TableClient
from azure.identity import DefaultAzureCredential

app = func.FunctionApp()
PARTITION = "medassist"


@app.timer_trigger(schedule="0 */15 * * * *", arg_name="timer", run_on_startup=False)
def send_due_reminders(timer: func.TimerRequest) -> None:
    credential = DefaultAzureCredential()
    table = TableClient(os.environ["REMINDERS_TABLE_URL"], table_name="reminders", credential=credential)
    sms = SmsClient(os.environ["SMS_ENDPOINT"], credential)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    due = table.query_entities("PartitionKey eq @p and remind_at le @now", parameters={"p": PARTITION, "now": now})
    sent = failed = 0
    for row in due:
        result = sms.send(from_=row["from"], to=row["to"], message=row["body"])[0]
        if result.successful:
            table.delete_entity(partition_key=PARTITION, row_key=row["RowKey"])
            sent += 1
        else:  # kept, so the next run tries again
            logging.warning("Reminder %s not sent: %s", row["RowKey"], result.error_message or result.http_status_code)
            failed += 1
    if sent or failed:
        logging.info("Reminders: %d sent, %d to try again", sent, failed)
