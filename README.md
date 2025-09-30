# AI Beta Reader Express

A REST API for getting AI-generated feedback on chapters with context from previous chapter summaries. Uses Express.js, PostgreSQL (Neon), and OpenAI's Responses API.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   Create a `.env` file in the project root with your credentials:
   ```bash
   # OpenAI Configuration
   OPENAI_API_KEY=sk-...

   # Database Configuration
   DATABASE_URL=postgres://USER:PASS@HOST/DBNAME?sslmode=require

   # Server Configuration
   PORT=3001

   # Auth0 Configuration
   AUTH0_DOMAIN=your-auth0-domain.auth0.com
   AUTH0_CLIENT_ID=your-auth0-client-id
   AUTH0_AUDIENCE=your-auth0-audience
   ```

3. **Set up database:**
   See the [Database Setup](#database-setup) section below for detailed instructions.

4. **Start the server:**
   ```bash
   npm run dev
   ```

## API Endpoints

**Note:** All endpoints except authentication routes require a valid Auth0 JWT token in the Authorization header.

### Authentication
- `POST /auth/profile` - Create/update user profile
- `GET /auth/me` - Get current user profile

### Books
- `GET /books` - Get user's books
- `POST /books` - Create/register a book
- `GET /books/:id/chapters` - List chapters (+ whether summarized)

### Chapters
- `POST /chapters` - Upsert a chapter (text lives in DB)
- `GET /chapters/:id` - Fetch a chapter & its summary
- `POST /chapters/:id/summary` - Generate + store AI summary

### Reviews
- `POST /reviews` - Create a chapter-specific review using prior summaries

## Usage Examples

### 1. Create a book
```bash
curl -X POST http://localhost:3001/books \
  -H "Content-Type: application/json" \
  -d '{"id":"nightshades","title":"Nightshades Draft v1"}'
```

### 2. Add a chapter
```bash
curl -X POST http://localhost:3001/chapters \
  -H "Content-Type: application/json" \
  -d '{"id":"ch-12","bookId":"nightshades","title":"Lantern House","text":"<paste full chapter text here>"}'
```

### 3. Generate chapter summary
```bash
curl -X POST http://localhost:3001/chapters/ch-12/summary
```

### 4. Get review with context
```bash
curl -X POST http://localhost:3001/reviews \
  -H "Content-Type: application/json" \
  -d '{"bookId":"nightshades","newChapterId":"ch-13","tone":"fanficnet"}'
```

### 5. List chapters
```bash
curl http://localhost:3001/books/nightshades/chapters
```

## Review Tones

- `fanficnet` - Enthusiastic fan style reader (default)
- `editorial` - Developmental editor with actionable notes
- `line-notes` - Line editor with concrete suggestions

## Environment Variables

Create a `.env` file in the project root and configure the following variables:

### Required Variables

| Variable | Description | Example | Where to Get It |
|----------|-------------|---------|-----------------|
| `OPENAI_API_KEY` | OpenAI API key for ChatGPT | `sk-proj-abc123...` | [OpenAI Platform](https://platform.openai.com/api-keys) |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host/db?sslmode=require` | Your Neon/PostgreSQL provider |
| `AUTH0_DOMAIN` | Your Auth0 domain | `your-app.auth0.com` | Auth0 Dashboard > Applications > Settings |
| `AUTH0_CLIENT_ID` | Auth0 application client ID | `abc123def456...` | Auth0 Dashboard > Applications > Settings |
| `AUTH0_AUDIENCE` | Auth0 API audience identifier | `https://your-app.auth0.com/api/v2/` | Auth0 Dashboard > APIs |

### Optional Variables

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `PORT` | Server port number | `3001` | `3001` |

### Example Configuration

```bash
# OpenAI Configuration
OPENAI_API_KEY=sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz567

# Database Configuration (Neon example)
DATABASE_URL=postgresql://username:password@ep-cool-lab-123456.us-east-1.aws.neon.tech/neondb?sslmode=require

# Server Configuration
PORT=3001

# Auth0 Configuration
AUTH0_DOMAIN=my-ai-app.auth0.com
AUTH0_CLIENT_ID=abc123def456ghi789jkl012mno345pqr
AUTH0_AUDIENCE=https://my-ai-app.auth0.com/api/v2/
```

### Setup Notes

1. **OpenAI API Key**: Sign up at [OpenAI Platform](https://platform.openai.com/) and create an API key
2. **Database**:
   - For Neon: Create a database at [Neon](https://neon.tech/) and copy the connection string
   - For local PostgreSQL: Use format `postgresql://user:password@localhost:5432/dbname`
3. **Auth0**:
   - Create an account at [Auth0](https://auth0.com/)
   - Create a new Application (API type)
   - Configure the audience and copy the domain/client ID
4. **Security**: Never commit `.env` to version control - it's in `.gitignore`

## Database Setup

### Option 1: Neon (Recommended)

[Neon](https://neon.tech/) is a serverless PostgreSQL platform that's perfect for this project.

1. **Create a Neon Account**
   - Go to [neon.tech](https://neon.tech/) and sign up
   - Create a new project
   - Choose a region close to your users

2. **Get Connection Details**
   - In your Neon dashboard, go to "Connection Details"
   - Copy the connection string (it looks like this):
     ```
     postgresql://username:password@ep-cool-lab-123456.us-east-1.aws.neon.tech/neondb?sslmode=require
     ```
   - Add this as `DATABASE_URL` in your `.env` file

3. **Run Database Schema**
   - In your Neon dashboard, go to "SQL Editor"
   - Copy and paste the contents of `schema.sql` from this repository
   - Click "Run" to create all the required tables

4. **Run Migrations (if needed)**
   - If you have the app running and need to update the schema, run the migration files in the `migrations/` folder
   - Copy and paste each migration file in order in the SQL Editor

### Option 2: Local PostgreSQL

If you prefer to run PostgreSQL locally:

1. **Install PostgreSQL**
   ```bash
   # macOS (using Homebrew)
   brew install postgresql
   brew services start postgresql

   # Ubuntu/Debian
   sudo apt-get install postgresql postgresql-contrib
   sudo systemctl start postgresql
   ```

2. **Create Database**
   ```bash
   # Create a new database
   createdb ai_beta_reader

   # Set your DATABASE_URL in .env
   DATABASE_URL=postgresql://username:password@localhost:5432/ai_beta_reader
   ```

3. **Run Schema**
   ```bash
   # Run the schema file
   psql ai_beta_reader < schema.sql

   # Run any migrations
   psql ai_beta_reader < migrations/001_initial_migration.sql
   # ... run other migration files in order
   ```

### Database Schema Overview

The application uses these main tables:

- **users** - User accounts linked to Auth0
- **books** - User's writing projects
- **chapters** - Individual chapters with content and word counts
- **chapter_summaries** - AI-generated summaries for context
- **book_parts** - Optional parts/sections for organizing chapters
- **wiki_pages** - Character sheets and world-building pages
- **reviews** - AI-generated feedback on chapters
- **ai_profiles** - Custom AI reviewer configurations

### Troubleshooting Database Issues

**Connection Issues:**
- Verify your `DATABASE_URL` is correct
- Check that your database is running
- For Neon, ensure your IP is allowed (Neon allows all IPs by default)

**Schema Issues:**
- Make sure you've run `schema.sql` completely
- Run migrations in the correct order if updating an existing database
- Check the server logs for specific SQL errors

## Notes

- Summaries are fed to reviews, not full chapters (for cost control)
- Only prior summaries are included (no spoilers beyond what's been summarized)
- OpenAI key stays on server for security
- Use structured JSON schema for consistent summary format