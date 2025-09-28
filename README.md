# AI Beta Reader Express

A REST API for getting AI-generated feedback on chapters with context from previous chapter summaries. Uses Express.js, PostgreSQL (Neon), and OpenAI's Responses API.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   Copy `.env` and fill in your credentials:
   ```bash
   OPENAI_API_KEY=sk-...
   DATABASE_URL=postgres://USER:PASS@HOST/DBNAME?sslmode=require
   PORT=3001

   # Auth0 Configuration
   AUTH0_DOMAIN=your-auth0-domain.auth0.com
   AUTH0_CLIENT_ID=your-auth0-client-id
   AUTH0_AUDIENCE=your-auth0-audience
   ```

3. **Set up database:**
   Run the SQL schema in your Neon console:
   ```bash
   cat schema.sql
   ```

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

- `fanficnet` - Enthusiastic serial reader (default)
- `editorial` - Developmental editor with actionable notes
- `line-notes` - Line editor with concrete suggestions

## Notes

- Summaries are fed to reviews, not full chapters (for cost control)
- Only prior summaries are included (no spoilers beyond what's been summarized)
- OpenAI key stays on server for security
- Use structured JSON schema for consistent summary format