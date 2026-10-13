#!/usr/bin/env python3
"""Send a plain-text report through SMTP using only the Python standard library."""

import argparse
import os
import smtplib
import ssl
from email.message import EmailMessage


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--subject", required=True)
    parser.add_argument("--body", required=True)
    args = parser.parse_args()

    host = os.environ["MAIL_HOST"]
    port = int(os.environ.get("MAIL_PORT", "465"))
    username = os.environ["MAIL_USERNAME"]
    password = os.environ["MAIL_PASSWORD"]
    sender = os.environ.get("MAIL_FROM", username)
    recipients = [item.strip() for item in os.environ["MAIL_TO"].split(",") if item.strip()]
    if not recipients:
        raise ValueError("MAIL_TO 不能为空")

    message = EmailMessage()
    message["Subject"] = args.subject
    message["From"] = sender
    message["To"] = ", ".join(recipients)
    message.set_content(open(args.body, encoding="utf-8").read())

    context = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=context, timeout=30) as smtp:
            smtp.login(username, password)
            smtp.send_message(message)
    else:
        with smtplib.SMTP(host, port, timeout=30) as smtp:
            smtp.ehlo()
            smtp.starttls(context=context)
            smtp.ehlo()
            smtp.login(username, password)
            smtp.send_message(message)


if __name__ == "__main__":
    main()
