# Setting up with clasp

`clasp` is Google's command-line tool for Apps Script. It creates the sheet and the bound script, pushes `Code.gs` and the manifest, and deploys the web app, all from this folder. Nothing needs to be installed: `npx` fetches it.

Two things only the account owner can do, because they involve a Google sign-in:

1. Enable the Apps Script API for the account, once: open https://script.google.com/home/usersettings and switch "Google Apps Script API" on.
2. Log in:

```bash
npx -y @google/clasp@3.4.1 login
```

A browser window opens; sign in with the account that should own the store and allow the access. The credentials land in `~/.clasprc.json`.

Everything below can then be run by anyone at this machine. All commands run inside the `sheets` folder.

```bash
cd sheets
```

Create a new Google Sheet with a bound script (writes `.clasp.json`, which is git-ignored, and a `parentId` for the sheet):

```bash
npx -y @google/clasp@3.4.1 create --type sheets --title "Still Waters store" --rootDir .
```

Push `Code.gs` and `appsscript.json` (the `.claspignore` keeps the templates and tests out):

```bash
npx -y @google/clasp@3.4.1 push -f
```

Open the script in the browser and, in the editor, run `setupTabs` once. The first run asks for permissions (Advanced, then Go to ..., then Allow). This creates the five tabs with the example rows and is the one step clasp cannot do for you.

```bash
npx -y @google/clasp@3.4.1 open-script
```

Fill in the Settings tab (owner emails, token, e-Transfer email, pickup note). The sheet itself opens with:

```bash
npx -y @google/clasp@3.4.1 open-container
```

Deploy the web app. The manifest already says "execute as the deploying user" and "anyone can access":

```bash
npx -y @google/clasp@3.4.1 deploy --description "store"
```

The command prints the deployment id. The web app URL is:

```
https://script.google.com/macros/s/DEPLOYMENT_ID/exec
```

List deployments any time with `npx -y @google/clasp@3.4.1 deployments`.

Put that URL and the token into `index.html` (`scriptUrl` and `token`), run `./build.sh` from the repository root, and test with `sheets/test/post-order.sh` as described in `SETUP.md`.

## Updating the script later

```bash
cd sheets
npx -y @google/clasp@3.4.1 push -f
npx -y @google/clasp@3.4.1 redeploy DEPLOYMENT_ID --description "update"
```

Redeploying keeps the same URL. A fresh `deploy` would create a second deployment with a new URL.

## Handing over to the store account

`clasp` is tied to whoever logged in. For the real store, David copies the sheet into the store account (File, Make a copy, which copies the bound script and the tabs too), opens Extensions, Apps Script there, approves the permissions, and deploys a new web app as in `SETUP.md` step 4; `setupTabs` is not needed because the tabs come with the copy. Or he runs `clasp login` with the store account and repeats the commands above from `create` onward. Either way the site config gets the new URL and token.
