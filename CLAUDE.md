# AI Beta Reader Express Backend - Claude Development Guide

## Project Overview
Express.js REST API for AI-powered creative writing feedback with Auth0 authentication and PostgreSQL/Neon database.

## Quick Start Commands
```bash
# Development
npm run dev

# Build
npm run build

# Production
npm start

# Install dependencies
npm install
```

## Project Structure
```
src/
├── server.ts          # Main Express server with all routes
├── auth.ts           # Auth0 JWT middleware and user management
├── db.ts             # PostgreSQL connection and transaction utilities
└── openai.ts         # OpenAI client configuration

schema.sql            # Database schema for Neon PostgreSQL
```

## Key Technologies
- **Express.js 5.x** - Web framework
- **TypeScript** - Type safety
- **Auth0** - Authentication (JWT + JWKS)
- **PostgreSQL (Neon)** - Database
- **OpenAI API** - AI summaries and reviews
- **Zod** - Request validation

## Environment Variables
```bash
# OpenAI
OPENAI_API_KEY=sk-...

# Database
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require

# Auth0
AUTH0_DOMAIN=your-domain.auth0.com
AUTH0_CLIENT_ID=your-client-id
AUTH0_AUDIENCE=https://your-domain.auth0.com/api/v2/

# Server
PORT=3001
```

## API Routes

### Authentication
- `POST /auth/profile` - Create/update user profile from Auth0 token
- `GET /auth/me` - Get current authenticated user

### Books (Protected)
- `GET /books` - Get user's books
- `POST /books` - Create new book
- `GET /books/:id/chapters` - List chapters for a book

### Chapters (Protected)
- `POST /chapters` - Create/update chapter
- `GET /chapters/:id` - Get chapter with summary
- `POST /chapters/:id/summary` - Generate AI summary

### Reviews (Protected)
- `POST /reviews` - Generate AI review with context

## Database Schema
- **users** - Auth0 integration (auth0_sub, email, username)
- **books** - User's books (linked via user_id)
- **chapters** - Book chapters with text content
- **chapter_summaries** - AI-generated structured summaries

## Auth0 Integration
- JWT verification with JWKS
- Automatic user profile creation
- Ownership verification for all resources
- Support for UI and programmatic tokens

## Common Tasks

### Adding New Routes
1. Add route handler to `src/server.ts`
2. Use `authenticateJWT` middleware for protected routes
3. Verify user ownership with `getUserFromAuth0Sub()`
4. Add Zod validation schemas

### Database Operations
- Use `pool.query()` for simple queries
- Use `withTx()` for transactions
- All user data is filtered by ownership

### Error Handling
- JWT errors return 401
- Ownership errors return 403
- Validation errors return 400
- Server errors return 500

## Testing Endpoints
```bash
# Get user profile (requires Auth0 token)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  http://localhost:3001/auth/me

# Create book
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"test-book","title":"My Test Book"}' \
  http://localhost:3001/books
```

## Development Notes
- Uses `tsx` for TypeScript execution (not ts-node)
- ES modules with .js import extensions required
- All routes require authentication except /auth/*
- OpenAI uses gpt-4o-mini model for cost efficiency
- Database foreign keys ensure data integrity

## Troubleshooting
- **Module errors**: Check .js extensions in imports
- **Auth errors**: Verify Auth0 environment variables
- **Database errors**: Check Neon connection string
- **Build errors**: Run `npm run build` to check TypeScript

## Recent Changes
- Integrated Auth0 authentication system
- Added user management and ownership verification
- Updated all routes to require authentication
- Fixed TypeScript ES module execution with tsx
- Added comprehensive error handling