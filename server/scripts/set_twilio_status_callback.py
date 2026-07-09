"""One-off: point the Twilio number's "call status changes" webhook at /api/voice/call_status.

That webhook delivers the authoritative CallDuration when each call completes,
which fills CallLog.duration_seconds for the retention metrics.

Usage (reads TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER / BASE_URL from .env):
    python3 scripts/set_twilio_status_callback.py
"""
import os
import sys

from dotenv import load_dotenv
from twilio.rest import Client

load_dotenv()

account_sid = os.environ.get("TWILIO_ACCOUNT_SID", "")
auth_token = os.environ.get("TWILIO_AUTH_TOKEN", "")
phone_number = os.environ.get("TWILIO_PHONE_NUMBER", "")
base_url = os.environ.get("BASE_URL", "https://chessnow.app").rstrip("/")

if not (account_sid and auth_token and phone_number):
    sys.exit("Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_PHONE_NUMBER in .env")

callback_url = f"{base_url}/api/voice/call_status"
client = Client(account_sid, auth_token)
numbers = client.incoming_phone_numbers.list(phone_number=phone_number)
if not numbers:
    sys.exit(f"No incoming number matching {phone_number} found on this account")

for number in numbers:
    number.update(status_callback=callback_url, status_callback_method="POST")
    print(f"✅ {number.phone_number}: status callback → {callback_url}")
