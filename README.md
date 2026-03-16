# Bank Of Bihar

Banking Transaction Management System built with HTML, CSS, JavaScript, Node.js, Express, and a database layer that works with:

- SQLite for local development
- PostgreSQL for cloud deployment

## Run locally

```powershell
cd C:\Users\ayush\Downloads\bank-of-bihar-system
npm.cmd install
npm.cmd start
```

Open `http://localhost:3000`

## Demo admin login

- Email: `admin@bankofbihar.in`
- Password: `Admin@123`

## Free deployment on Render

1. Push this folder to a GitHub repository.
2. Sign in to Render and create a new Blueprint deployment.
3. Select the GitHub repository containing this project.
4. Render will read `render.yaml` and create:
   - a free Node web service
   - a free PostgreSQL database
5. After deployment finishes, open the generated Render URL.

## Environment variables

- `PORT`: local server port
- `DATABASE_URL`: when set, the app uses PostgreSQL
- `DATABASE_SSL`: set to `true` only when your PostgreSQL provider requires SSL
