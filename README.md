MEDICALL AI — PROJECT SETUP GUIDE

This file explains how to install, configure, run, and push the MediCall
AI project. Run commands from a Linux Mint terminal.

1. PROJECT FOLDERS

Expected layout:

    medicall-ai/
      client/
      server/
      .gitignore

2. INSTALL DEPENDENCIES

Frontend:

    cd ~/Desktop/medicall-ai/client
    npm install

Backend (open a second terminal or return to the project root first):

    cd ~/Desktop/medicall-ai/server
    npm install

3. CONFIGURE ENVIRONMENT VARIABLES

Create local environment files on your own computer. Do not commit them
to GitHub.

Backend: ~/Desktop/medicall-ai/server/.env

Frontend: ~/Desktop/medicall-ai/client/.env

Copy the variable names from your project’s existing configuration or
README and enter your own values. Common backend settings may include a
MongoDB connection string, JWT secret, Groq API key, and Sarvam API key,
depending on the features enabled.

IMPORTANT: - Never paste API keys, passwords, tokens, or service-account
credentials into source files. - Never upload either .env file to
GitHub. - If a key was exposed in a commit or shared output,
revoke/rotate it with its provider and update the local .env file. -
Frontend environment variables bundled into a Vite app are visible to
users if exposed to the browser. Never put private API keys in
client/.env. - Keep .env.example limited to variable names and safe
placeholder values, for example: MONGODB_URI= JWT_SECRET= GROQ_API_KEY=
SARVAM_API_KEY= Adjust names to match the actual application code.

4. ENSURE SECRETS ARE IGNORED BY GIT

From the project root:

    cd ~/Desktop/medicall-ai

Add these lines to .gitignore if they are not already present:

    node_modules/
    client/node_modules/
    server/node_modules/
    client/dist/
    .env
    .env.*
    !.env.example
    client/.env
    server/.env

If a .env file was already tracked, remove it from Git tracking without
deleting the local file:

    git rm --cached --ignore-unmatch client/.env server/.env

Check which env files Git still tracks:

    git ls-files | grep -E '(^|/)\.env($|\.)'

If this prints client/.env or server/.env, stop and remove those files
from tracking before pushing.

5. RUN THE APP

Terminal 1 — backend:

    cd ~/Desktop/medicall-ai/server
    npm install
    node server.js

Terminal 2 — frontend:

    cd ~/Desktop/medicall-ai/client
    npm install
    npm run dev

Open the local URL printed by Vite, usually http://localhost:5173. If
the backend fails, check its terminal output, MongoDB connection, and
backend .env values.

6. COMMIT AND PUSH TO GITHUB

From the project root:

    cd ~/Desktop/medicall-ai
    git status
    git remote -v

If the repository has already been initialized and connected to the
correct GitHub remote, stage the setup guide and other safe changes:

    git add SETUP.txt .gitignore
    git status

Review staged files carefully. Do not commit .env files, service account
JSON files, credentials, or API keys.

If the initial commit contains a secret and the push was rejected before
anything reached GitHub, and the initial commit is the only local
commit, amend that commit after removing secrets from tracking:

    git commit --amend --no-edit
    git push -u origin main

If there are multiple commits, or the secret was already pushed
successfully, stop and clean the Git history carefully before pushing.
Rotate any exposed keys. Do not use GitHub’s secret-allow/bypass link.

7. TROUBLESHOOTING

-   “not a git repository”: cd into ~/Desktop/medicall-ai first.
-   “remote origin already exists”: check git remote -v; do not add it
    again.
-   “src refspec main does not match any”: ensure there is a commit and
    run git branch -M main.
-   Push protection secret warning: do not bypass it. Remove secrets
    from tracked files and affected commits, rotate keys, then retry.
-   Authentication failure: follow GitHub’s current authentication
    instructions; account passwords are not accepted for Git over HTTPS.

This guide is generic project setup guidance. Check the project’s code
and existing README for the exact environment variable names and
required values.
