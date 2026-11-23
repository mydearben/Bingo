# People Bingo — Human Bingo for company events

A mobile-first Human Bingo web app designed for up to 200 attendees. Participants join a six-character room, receive a shuffled 5×5 card (24 prompts + a free centre square), enter a different colleague's name for each square, and submit a completed line for organiser review.

## Included

- Participant join screen and mobile-friendly 5×5 card
- Randomised card allocation per participant
- Colleague-name entry, with duplicate-name and self-name checks
- Horizontal, vertical and diagonal Bingo detection
- Organiser sign-in via Supabase Auth
- Room status/capacity controls, editable prompts, attendee list, CSV export
- Manual approve/reject workflow for submissions
- Supabase SQL schema with restricted table access and RPC functions
- GitHub Pages deployment workflow

## Architecture

- **GitHub Pages** hosts the static website.
- **Supabase** provides PostgreSQL, RPC functions and organiser authentication.
- Only the Supabase project URL and anon/public key are used in browser code. Never publish a `service_role` key.

The app is a custom Human Bingo implementation, not RoomZing source code or branding.

## 1. Create the Supabase project

1. Create a Supabase project.
2. In **Authentication → Users**, create an organiser user with an email and password.
3. Open **SQL Editor** and run `supabase/schema.sql`.
4. In the seed statement at the bottom of the SQL file, replace:
   - `YOUR-AUTH-USER-UUID` with the organiser user's Auth UID.
   - `TEAM26` with your preferred six-character room code.
   - Event name and prompts as desired.
5. Uncomment and run the seed `INSERT` statement.
6. In **Project Settings → API**, copy the Project URL and anon/public key.

## 2. Configure the website

1. Copy `config.example.js` to `config.js` (or rename `config.example.js` to `config.js`).
2. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `config.js`.
3. Do not add a service-role key, database password or other secret to `config.js`.

For local preview, serve this folder with any static HTTP server. For example, with Python installed:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## 3. Publish to GitHub Pages

1. Create a GitHub repository. It may be private if your GitHub plan supports Pages for private repositories; note that the published Pages site itself is normally publicly reachable.
2. Upload the project files, including `config.js` (it contains only the public anon key and project URL).
3. In repository **Settings → Pages**, choose **GitHub Actions** as the deployment source.
4. The included `.github/workflows/pages.yml` deploys the repository as a static site.
5. After deployment, open the Pages URL and test joining with the room code.

If your repository name is not the account root repository, the relative asset paths in this app work under the project subpath.

## 4. Before the event: test checklist

- Join from two or more different phones and browsers.
- Confirm each attendee receives a shuffled card.
- Confirm the centre free square is not editable.
- Confirm the same colleague cannot be entered twice on one card.
- Confirm a participant cannot enter their own name.
- Confirm a Bingo line can be submitted.
- Sign in as organiser and approve/reject a test submission.
- Check the attendee count and CSV export.
- Test the room pause/close controls.
- Load-test with a realistic number of simultaneous connections.
- Keep a backup copy of the SQL and prompts.

## Important production notes

- **Do not treat a room code as authentication.** Anyone with the code can join while the room is open.
- The attendee's session token is stored in browser memory for the active session. Refresh/rejoin recovery and stronger participant identity controls should be added before using this for a high-stakes event.
- Organiser access is protected by Supabase Auth and database-side organiser ownership checks.
- The participant-facing UI does not reveal the full attendee list or other participants' cards.
- Supabase free-tier quotas, inactivity pausing, and current connection limits can change. Review the current Supabase plan and run a load test before the event.
- This starter does not implement a public live leaderboard or QR image generator yet. The join URL can be copied and converted to a QR code using a trusted QR tool, or these features can be added in a follow-up iteration.
- Consider publishing a short privacy notice explaining that names entered into squares and participant registration are stored for event administration. Agree on a retention/deletion period with your company.

## Troubleshooting

- **Setup required message:** check `config.js` and ensure the URL and anon key are correct.
- **Room code not found:** check the room seed was run and the code is exactly six uppercase letters/numbers.
- **No organiser room:** check the room's `organiser_id` matches the Auth UID of the signed-in organiser.
- **Cannot sign in:** confirm the organiser user exists and email/password sign-in is enabled in Supabase Auth.
- **Permission/RPC errors:** rerun `supabase/schema.sql` and inspect Supabase Logs.

## Current scope / next improvements

This is a functional starter build. Recommended next enhancements before the event are persistent participant session recovery, QR code display, real-time push updates (the current organiser dashboard polls every 8 seconds), configurable win rules, and a participant consent/privacy notice.
