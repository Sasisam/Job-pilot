# JobPilot Pro — India multi-portal auto-apply

Upload your resume once. JobPilot searches **Naukri, foundit, Shine, Internshala** + **120+ company career pages** (Greenhouse / Lever / Ashby), scores each job against your resume, and **applies for you**.

**Target mix:** ~90% automatic apply (company sites + portal Easy Apply), ~10% manual (LinkedIn / Hirist / Indeed style sites whose terms forbid bots).

Runs on your own PC. Dashboard: http://127.0.0.1:8000

---

## What’s new in Pro

- **Unique purple-indigo dashboard (v9)** — dark/light themes, modern cards, clear match scores, Tier 1/2/3 filters
- **Filters always visible** on Jobs page: Roles · Cities · Work style · Company size · Company type · Search on
- **Multi-portal by default** — Naukri + foundit + Shine + Internshala + company career pages
- **Only matching roles shown** — keyword + optional AI scoring
- **Full auto-fill + auto-submit** — bot fills every form field from your resume and submits; success emails to your inbox
- **Company own career pages** — Greenhouse / Lever / Ashby forms filled & submitted automatically
- **Clickable Email / AI / Alert** in the header — configure SMTP once; every successful apply is emailed to you
- **Tier 1 / Tier 2 / Tier 3** company filters on the Jobs sidebar

---

## Quick start

1. Install **Python 3.10, 3.11, or 3.12** (Python 3.12 is recommended; on Windows tick "Add Python to PATH").
2. **Windows:** double-click `run.bat`  
   **Mac / Linux:** `./run.sh`  
   First run installs dependencies (a few minutes). The dashboard opens automatically.
3. Open **Resume** → drop your PDF/DOCX → check name, email, phone, skills, notice period, CTC.
4. Open **Portals** → **Connect** Naukri (and foundit / Shine / Internshala) → log in in the browser window → press **I'm logged in**.
5. Open **Jobs** → set roles + cities + filters on the left → **Find jobs**.
6. Press **Select strong** → **Auto apply selected**.

Optional: put `ANTHROPIC_API_KEY` (better scoring + cover notes) and email/phone alerts in `.env`.

---

## What gets auto-applied (~90%)

| Source | How apply works |
|--------|-----------------|
| **Company career pages** (Greenhouse, Lever, Ashby) | Bot opens the form, fills fields from your resume, uploads CV, submits |
| **Naukri, foundit, Shine, Internshala** | Uses *your* logged-in browser; clicks Easy / Quick Apply |
| **Adzuna India** (optional free API key) | Extra listings; apply path depends on the employer site |

Fill **notice period**, **current CTC**, **expected CTC** in Resume so the bot can answer those common questions without stopping.

## What stays manual (~10%)

LinkedIn, Indeed, Instahyre, Cutshort, Hirist, Wellfound, TimesJobs, apna — JobPilot only opens a ready-made search. Their terms ban automation; automating them risks account bans. You apply yourself; mark "I applied" in the dashboard.

---

## Safety & control

- **Stop** button (top progress bar / bottom dock) halts search or auto-apply within 1–2 seconds.
- First week tip: turn on **Review before submit** in the bottom dock so the bot fills forms and waits for **Approve & submit**. Switch off when you trust it.
- Daily limit + random pauses protect portal accounts. Keep daily applications under ~30.
- Captcha, screening questions, or missing required fields → job goes to **Waiting**. The bot never invents answers.
- Portal logins stay only in `data/browser_profiles` on your PC. JobPilot never sees your password.

---

## Environment (`.env`)

```
ANTHROPIC_API_KEY=          # optional, better scoring + cover notes
AUTO_SUBMIT=false           # false = fill only (safer); true = also submit
MIN_MATCH_SCORE=55
DAILY_APPLY_CAP=25
HEADLESS=true               # company forms
PORTAL_HEADLESS=false       # portals: visible window is safer
ADZUNA_APP_ID=              # optional free key
ADZUNA_APP_KEY=
```

Built for personal use on your machine. Use responsibly and respect each site's terms of service.


---

## Safety fixes in this build

- **Default is review mode** (`AUTO_SUBMIT=false`) — bot fills forms; you press Approve & submit.
- **Daily apply cap** enforced on every auto-apply and approve action (not only scheduled runs).
- **Duplicate URL skip** — same job listing will not be applied twice.
- **Resume upload limit** — max 8 MB; PDF/DOCX/TXT only.
- **Job ownership checks** — status/approve/retry only touch your jobs.
- **Stale UI fixed** — job list refreshes when a run finishes so Applied / Failed status is current.
- **`.env.example` included** — first run copies it to `.env`.
- Binds to `127.0.0.1` only (not exposed on the network).


## Windows dependency/startup repair

The Windows `run.bat` now creates and uses the project's `.venv` interpreter explicitly, installs `requirements.txt` on every launch (pip skips packages that are already satisfied), and installs the Playwright Chromium browser. This prevents the app from accidentally launching with a different global Python installation that does not contain FastAPI. Python 3.13+ is not selected by this launcher; use Python 3.12 for the supported setup.

### Windows Python version note

`run.bat` prefers Python 3.12, 3.11, or 3.10 when installed. It can also attempt Python 3.15, 3.14, or 3.13, but package compatibility on newer Python versions depends on whether compatible wheels have been published. If dependency installation fails, install Python 3.12 and run `run.bat` again. The launcher creates an isolated `.venv` and installs `requirements.txt` before starting the API.


## v11 — Multi-user + login (Created by SASI)

- **User accounts**: each teammate has their own login, resume, jobs, preferences and portal connections.
- **Admin**: first registered account is admin. Admin can create users and see **login counts / history**.
- **Auth**: username/password with correct “Username or password incorrect” on failure. Optional Google / GitHub / Apple style sign-in (email-based identity for team use).
- **Isolation**: browser profiles and resumes are per-user (`data/browser_profiles/user_<id>/`, `resume/user_<id>/`).
- **Portal Connect**: clearer errors when automation cannot run (e.g. pure mobile browser). Prefer desktop for Naukri / foundit Connect.

## v10 — Mobile / tablet / desktop (Created by SASI)

- Adaptive layout: sidebar on desktop (≥1024px), top app bar + bottom tab bar on phones/tablets.
- Filters collapse into a "Filters" drawer on small screens; job cards stack with thumb-size buttons.
- SASI logo (`static/logo.svg`), "Created by SASI" in sidebar, app bar and footer; installable as an app (PWA manifest + icons).
- Public hosting: use the `Procfile.dev` style command (`--host 0.0.0.0`). Login is required; still keep SECRET_KEY strong and prefer HTTPS when exposing publicly.
