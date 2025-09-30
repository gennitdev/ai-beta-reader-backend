import "dotenv/config";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { pool, withTx } from "./db.js";
import { openai } from "./openai.js";
import { authenticateJWT, optionalAuth, upsertUser, getUserFromAuth0Sub, AuthenticatedRequest } from "./auth.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ---- validators
const UpsertBook = z.object({
  id: z.string().min(1),
  title: z.string().min(1)
});
const UpsertChapter = z.object({
  id: z.string().min(1),
  bookId: z.string().min(1),
  title: z.string().optional(),
  text: z.string().min(1)
});
const ReviewReq = z.object({
  bookId: z.string().min(1),
  newChapterId: z.string().min(1),
  tone: z.enum(["fanficnet","editorial","line-notes"]).optional(),
  customProfileId: z.number().optional()
});
const CreateAIProfile = z.object({
  name: z.string().min(1),
  tone_key: z.string().min(1),
  system_prompt: z.string().min(1),
  is_default: z.boolean().optional()
});
const UpdateAIProfile = z.object({
  name: z.string().min(1).optional(),
  system_prompt: z.string().min(1).optional(),
  is_default: z.boolean().optional()
});
const CreateCustomReviewerProfile = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1)
});
const UpdateCustomReviewerProfile = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().min(1).optional()
});
const CreateWikiPage = z.object({
  page_name: z.string().min(1),
  page_type: z.enum(['character', 'location', 'concept', 'other']).optional(),
  content: z.string().optional(),
  summary: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  is_major: z.boolean().optional()
});
const UpdateWikiPage = z.object({
  page_name: z.string().min(1).optional(),
  page_type: z.enum(['character', 'location', 'concept', 'other']).optional(),
  content: z.string().optional(),
  summary: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  is_major: z.boolean().optional()
});

// ---- Auth routes
app.post("/auth/profile", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    // Upsert user data from Auth0 token
    const userData = await upsertUser({
      auth0_sub: req.user.sub,
      email: req.user.email,
      email_verified: req.user.email_verified,
      username: req.user.username || undefined
    });

    res.json({
      ok: true,
      user: {
        id: userData.id,
        email: userData.email,
        username: userData.username,
        name: userData.name,
        email_verified: userData.email_verified
      }
    });
  } catch (error) {
    console.error("Profile creation error:", error);
    res.status(500).json({ error: "Failed to create/update profile" });
  }
});

app.get("/auth/me", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    res.json({
      ok: true,
      user: {
        id: dbUser.id,
        email: dbUser.email,
        username: dbUser.username,
        name: dbUser.name,
        email_verified: dbUser.email_verified
      }
    });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({ error: "Failed to get profile" });
  }
});

// ---- Book routes
app.post("/books", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const data = UpsertBook.parse(req.body);

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found. Please create your profile first." });
    }


    await pool.query(
      `INSERT INTO books(id, title, user_id, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         title=EXCLUDED.title,
         updated_at=now()`,
      [data.id, data.title, dbUser.id]
    );

    res.json({ ok: true });
  } catch (error) {
    console.error("Create book error:", error);
    res.status(500).json({ error: "Failed to create book" });
  }
});

app.get("/books", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    const { rows } = await pool.query(
      `SELECT b.id, b.title, b.created_at, b.updated_at,
              COUNT(c.id) as chapter_count,
              COALESCE(SUM(array_length(string_to_array(c.text, ' '), 1)), 0) as total_word_count
       FROM books b
       LEFT JOIN chapters c ON c.book_id = b.id
       WHERE b.user_id = $1
       GROUP BY b.id, b.title, b.created_at, b.updated_at
       ORDER BY b.updated_at DESC`,
      [dbUser.id]
    );

    res.json(rows);
  } catch (error) {
    console.error("Get books error:", error);
    res.status(500).json({ error: "Failed to get books" });
  }
});

app.post("/chapters", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const data = UpsertChapter.parse(req.body);
    const wordCount = data.text.trim().split(/\s+/).length;

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the book
    const { rows: bookRows } = await pool.query(
      'SELECT user_id FROM books WHERE id = $1',
      [data.bookId]
    );

    if (!bookRows.length) {
      return res.status(404).json({ error: "Book not found" });
    }

    if (bookRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to add chapters to this book" });
    }

    // Insert or update chapter (no position fields needed)
    await pool.query(
      `INSERT INTO chapters(id, book_id, title, text, word_count, updated_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (id) DO UPDATE SET
         book_id=EXCLUDED.book_id,
         title=EXCLUDED.title,
         text=EXCLUDED.text,
         word_count=EXCLUDED.word_count,
         updated_at=now()`,
      [data.id, data.bookId, data.title ?? null, data.text, wordCount]
    );

    // Add new chapter to the end of book's chapter_order array (only if not already present)
    await pool.query(
      `UPDATE books
       SET chapter_order = CASE
         WHEN $2 = ANY(chapter_order) THEN chapter_order
         ELSE array_append(chapter_order, $2)
       END
       WHERE id = $1`,
      [data.bookId, data.id]
    );

    res.json({ ok: true, wordCount });
  } catch (error) {
    console.error("Create chapter error:", error);
    res.status(500).json({ error: "Failed to create chapter" });
  }
});

// Generate + store a structured summary for a chapter
app.post("/chapters/:id/summary", authenticateJWT, async (req: AuthenticatedRequest, res, next) => {
  try {
    const chapterId = req.params.id;

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    const { rows } = await pool.query(
      `SELECT c.id, c.title, c.text, c.book_id, b.title as book_title, b.user_id
         FROM chapters c
         JOIN books b ON c.book_id=b.id
        WHERE c.id=$1`, [chapterId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Chapter not found" });
    }

    const chapter = rows[0];

    // Verify user owns the book
    if (chapter.user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to access this chapter" });
    }

    // Check if this is the first chapter by counting previous chapters
    const { rows: chapterCountRows } = await pool.query(
      `SELECT COUNT(*) as chapter_count
       FROM chapters c
       WHERE c.book_id = $1 AND c.id < $2`,
      [chapter.book_id, chapterId]
    );

    const isFirstChapter = parseInt(chapterCountRows[0].chapter_count) === 0;

    // call OpenAI Chat Completions API with JSON mode
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Use a model that supports JSON mode
      messages: [
        { role: "system", content:
          `You are an expert fiction editor. Produce a tight factual summary (150–250 words), include POV, main characters, and 4–8 bullet beats. No speculation. Return valid JSON only.${isFirstChapter ? ' IMPORTANT: This is the FIRST chapter of the book - there are no previous chapters to reference. Focus only on what happens in this opening chapter.' : ''}`},
        { role: "user", content:
          `Book: ${chapter.book_title} (${chapter.book_id})\n` +
          `Chapter: ${chapter.id}${chapter.title ? ` — ${chapter.title}` : ""}${isFirstChapter ? ' (FIRST CHAPTER)' : ''}\n\n` +
          `${isFirstChapter ? 'This is the opening chapter of the book. Summarize only what happens in this first chapter. Do not reference any previous events or chapters.\n\n' : ''}` +
          "Return JSON only for this schema: {pov, characters[], beats[], spoilers_ok, summary}\n\n" +
          chapter.text
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No content received from OpenAI");
    }
    const out = JSON.parse(content);

    await pool.query(
      `INSERT INTO chapter_summaries (chapter_id, pov, characters, beats, spoilers_ok, summary)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (chapter_id) DO UPDATE SET
         pov=EXCLUDED.pov,
         characters=EXCLUDED.characters,
         beats=EXCLUDED.beats,
         spoilers_ok=EXCLUDED.spoilers_ok,
         summary=EXCLUDED.summary,
         created_at=now()`,
      [chapterId, out.pov || null, JSON.stringify(out.characters||[]),
       JSON.stringify(out.beats||[]), !!out.spoilers_ok, out.summary]
    );

    // Update wiki pages for characters mentioned in this chapter
    if (out.characters && out.characters.length > 0) {
      await updateWikiPagesFromChapter(chapter.book_id, chapterId, out.characters, chapter.text, out.summary);
    }

    res.json({ ok: true, summary: out });
  } catch (e) { next(e); }
});

// Update chapter summary manually
app.put("/chapters/:id/summary", authenticateJWT, async (req: AuthenticatedRequest, res, next) => {
  try {
    const chapterId = req.params.id;
    const { summary } = req.body;

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    if (!summary || typeof summary !== 'string') {
      return res.status(400).json({ error: "Summary is required and must be a string" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the chapter
    const { rows: chapterRows } = await pool.query(
      `SELECT c.id, b.user_id
       FROM chapters c
       JOIN books b ON c.book_id = b.id
       WHERE c.id = $1`,
      [chapterId]
    );

    if (!chapterRows.length) {
      return res.status(404).json({ error: "Chapter not found" });
    }

    if (chapterRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to edit this chapter" });
    }

    // Update just the summary field
    await pool.query(
      `UPDATE chapter_summaries
       SET summary = $1, created_at = now()
       WHERE chapter_id = $2`,
      [summary, chapterId]
    );

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Helper function to update wiki pages from chapter summaries
async function updateWikiPagesFromChapter(bookId: string, chapterId: string, characters: string[], chapterText: string, chapterSummary: string) {
  try {
    for (const characterName of characters) {
      // Update or create book character entry first
      await pool.query(
        `INSERT INTO book_characters (book_id, character_name, first_mentioned_chapter, mention_count)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (book_id, character_name)
         DO UPDATE SET
           mention_count = book_characters.mention_count + 1,
           updated_at = now()`,
        [bookId, characterName, chapterId]
      );
      // Check if wiki page already exists for this character
      const { rows: existingPages } = await pool.query(
        'SELECT * FROM wiki_pages WHERE book_id = $1 AND page_name = $2',
        [bookId, characterName]
      );

      let wikiPageId: number;
      let isNewPage = false;

      if (existingPages.length === 0) {
        // Create new wiki page for this character
        const newPageContent = await generateWikiContent(characterName, chapterText, chapterSummary, null);

        const { rows: newPageRows } = await pool.query(
          `INSERT INTO wiki_pages (book_id, page_name, page_type, content, summary, created_by_ai)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [bookId, characterName, 'character', newPageContent.content, newPageContent.summary, true]
        );

        wikiPageId = newPageRows[0].id;
        isNewPage = true;

        // Update book_characters to link to this wiki page
        await pool.query(
          `UPDATE book_characters SET has_wiki_page = true, wiki_page_id = $1
           WHERE book_id = $2 AND character_name = $3`,
          [wikiPageId, bookId, characterName]
        );

        // Log the creation
        await pool.query(
          `INSERT INTO wiki_updates (wiki_page_id, chapter_id, update_type, new_content, change_summary)
           VALUES ($1, $2, $3, $4, $5)`,
          [wikiPageId, chapterId, 'created', newPageContent.content, `Created from chapter summary - first mention of ${characterName}`]
        );
      } else {
        // Update existing wiki page
        const existingPage = existingPages[0];
        wikiPageId = existingPage.id;

        const updatedContent = await generateWikiContent(characterName, chapterText, chapterSummary, existingPage.content);

        if (updatedContent.hasChanges) {
          await pool.query(
            `UPDATE wiki_pages SET content = $1, summary = $2, updated_at = now()
             WHERE id = $3`,
            [updatedContent.content, updatedContent.summary, wikiPageId]
          );

          // Log the update
          await pool.query(
            `INSERT INTO wiki_updates (wiki_page_id, chapter_id, update_type, previous_content, new_content, change_summary, contradiction_notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              wikiPageId,
              chapterId,
              updatedContent.hasContradictions ? 'contradiction_noted' : 'updated',
              existingPage.content,
              updatedContent.content,
              updatedContent.changeSummary,
              updatedContent.contradictions || null
            ]
          );
        }
      }

      // Record the mention in chapter_wiki_mentions
      await pool.query(
        `INSERT INTO chapter_wiki_mentions (chapter_id, wiki_page_id, mention_context)
         VALUES ($1, $2, $3)
         ON CONFLICT (chapter_id, wiki_page_id)
         DO UPDATE SET mention_context = EXCLUDED.mention_context`,
        [chapterId, wikiPageId, `Mentioned in chapter summary: ${chapterSummary.substring(0, 100)}...`]
      );
    }
  } catch (error) {
    console.error('Error updating wiki pages from chapter:', error);
    // Don't throw - we don't want wiki updates to fail the summary generation
  }
}

// Generate or update wiki content using AI
async function generateWikiContent(characterName: string, chapterText: string, chapterSummary: string, existingContent: string | null) {
  try {
    const isNewPage = !existingContent;

    const systemPrompt = isNewPage
      ? `You are a wiki editor creating a character page. Create a comprehensive character profile based on the information provided. Return JSON with: {content: "markdown content", summary: "brief summary", hasChanges: true}`
      : `You are a wiki editor updating a character page. Compare the existing content with new information from the chapter. Update the wiki to include new information and note any contradictions. Return JSON with: {content: "updated markdown", summary: "updated summary", hasChanges: boolean, changeSummary: "what changed", hasContradictions: boolean, contradictions: "contradictions found"}`;

    const userPrompt = isNewPage
      ? `Create a wiki page for character: ${characterName}

Chapter Summary: ${chapterSummary}

Chapter Text Context: ${chapterText.substring(0, 2000)}...

Create a character profile with sections for:
- Basic Information
- Appearance
- Personality
- Background
- Relationships
- Chapter Appearances`
      : `Update the wiki page for character: ${characterName}

EXISTING WIKI CONTENT:
${existingContent}

NEW CHAPTER INFORMATION:
Chapter Summary: ${chapterSummary}
Chapter Text Context: ${chapterText.substring(0, 2000)}...

Update the wiki with any new information. If there are contradictions with existing content, note them clearly in a "Contradictions" section.`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No content received from OpenAI for wiki generation");
    }

    return JSON.parse(content);
  } catch (error) {
    console.error('Error generating wiki content:', error);
    // Return a basic fallback
    return {
      content: `# ${characterName}\n\nMentioned in chapter summary: ${chapterSummary}`,
      summary: `Character from the story`,
      hasChanges: true,
      changeSummary: 'Basic wiki page created due to AI generation error'
    };
  }
}

// ---- AI Profiles routes
app.get("/ai-profiles", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Get user's custom profiles and system profiles
    const { rows } = await pool.query(
      `SELECT id, name, tone_key, system_prompt, is_default, is_system, created_at, updated_at
       FROM ai_profiles
       WHERE user_id = $1 OR is_system = true
       ORDER BY is_system DESC, name ASC`,
      [dbUser.id]
    );

    res.json(rows);
  } catch (error) {
    console.error("Get AI profiles error:", error);
    res.status(500).json({ error: "Failed to get AI profiles" });
  }
});

app.get("/ai-profiles/:id", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const profileId = req.params.id;

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Get AI profile details
    const { rows: profileRows } = await pool.query(
      `SELECT id, name, tone_key, system_prompt, created_at, is_system, is_default
       FROM ai_profiles
       WHERE id = $1`,
      [profileId]
    );

    if (!profileRows.length) {
      return res.status(404).json({ error: "AI profile not found" });
    }

    const profile = profileRows[0];

    // Get all reviews by this AI profile that the user can access (reviews on user's chapters)
    const { rows: reviewRows } = await pool.query(
      `SELECT r.id, r.review_text, r.created_at, r.updated_at,
              c.id as chapter_id, c.title as chapter_title,
              b.id as book_id, b.title as book_title
       FROM chapter_reviews r
       JOIN chapters c ON r.chapter_id = c.id
       JOIN books b ON c.book_id = b.id
       WHERE r.ai_profile_id = $1 AND b.user_id = $2
       ORDER BY r.created_at DESC`,
      [profileId, dbUser.id]
    );

    res.json({
      profile,
      reviews: reviewRows
    });
  } catch (error) {
    console.error("Get AI profile error:", error);
    res.status(500).json({ error: "Failed to get AI profile" });
  }
});

app.post("/ai-profiles", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const data = CreateAIProfile.parse(req.body);

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // If setting as default, unset other defaults first
    if (data.is_default) {
      await pool.query(
        'UPDATE ai_profiles SET is_default = false WHERE user_id = $1',
        [dbUser.id]
      );
    }

    const { rows } = await pool.query(
      `INSERT INTO ai_profiles (user_id, name, tone_key, system_prompt, is_default)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, tone_key, system_prompt, is_default, is_system, created_at, updated_at`,
      [dbUser.id, data.name, data.tone_key, data.system_prompt, data.is_default || false]
    );

    res.json({ ok: true, profile: rows[0] });
  } catch (error) {
    console.error("Create AI profile error:", error);
    res.status(500).json({ error: "Failed to create AI profile" });
  }
});

app.put("/ai-profiles/:id", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const profileId = req.params.id;
    const data = UpdateAIProfile.parse(req.body);

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the profile and it's not a system profile
    const { rows: profileRows } = await pool.query(
      'SELECT user_id, is_system FROM ai_profiles WHERE id = $1',
      [profileId]
    );

    if (!profileRows.length) {
      return res.status(404).json({ error: "AI profile not found" });
    }

    if (profileRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to edit this profile" });
    }

    if (profileRows[0].is_system) {
      return res.status(403).json({ error: "Cannot edit system profiles" });
    }

    // If setting as default, unset other defaults first
    if (data.is_default) {
      await pool.query(
        'UPDATE ai_profiles SET is_default = false WHERE user_id = $1',
        [dbUser.id]
      );
    }

    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (data.name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(data.name);
    }
    if (data.system_prompt !== undefined) {
      updates.push(`system_prompt = $${paramIndex++}`);
      values.push(data.system_prompt);
    }
    if (data.is_default !== undefined) {
      updates.push(`is_default = $${paramIndex++}`);
      values.push(data.is_default);
    }

    updates.push(`updated_at = now()`);
    values.push(profileId);

    const { rows } = await pool.query(
      `UPDATE ai_profiles SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING id, name, tone_key, system_prompt, is_default, is_system, created_at, updated_at`,
      values
    );

    res.json({ ok: true, profile: rows[0] });
  } catch (error) {
    console.error("Update AI profile error:", error);
    res.status(500).json({ error: "Failed to update AI profile" });
  }
});

app.delete("/ai-profiles/:id", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const profileId = req.params.id;

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the profile and it's not a system profile
    const { rows: profileRows } = await pool.query(
      'SELECT user_id, is_system FROM ai_profiles WHERE id = $1',
      [profileId]
    );

    if (!profileRows.length) {
      return res.status(404).json({ error: "AI profile not found" });
    }

    if (profileRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to delete this profile" });
    }

    if (profileRows[0].is_system) {
      return res.status(403).json({ error: "Cannot delete system profiles" });
    }

    await pool.query('DELETE FROM ai_profiles WHERE id = $1', [profileId]);

    res.json({ ok: true });
  } catch (error) {
    console.error("Delete AI profile error:", error);
    res.status(500).json({ error: "Failed to delete AI profile" });
  }
});

// ---- Chapter Reviews routes
app.get("/chapters/:id/reviews", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const chapterId = req.params.id;

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the chapter
    const { rows: chapterRows } = await pool.query(
      `SELECT c.id, b.user_id
       FROM chapters c
       JOIN books b ON c.book_id = b.id
       WHERE c.id = $1`,
      [chapterId]
    );

    if (!chapterRows.length) {
      return res.status(404).json({ error: "Chapter not found" });
    }

    if (chapterRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to access this chapter" });
    }

    // Get all reviews for this chapter (both AI profiles and custom profiles)
    const { rows } = await pool.query(
      `SELECT r.id, r.review_text, r.prompt_used, r.created_at, r.updated_at,
              CASE
                WHEN r.ai_profile_id IS NOT NULL THEN r.ai_profile_id::text
                WHEN r.custom_profile_id IS NOT NULL THEN 'custom-' || r.custom_profile_id::text
                ELSE NULL
              END as profile_id,
              COALESCE(p.name, cp.name) as profile_name,
              p.tone_key,
              CASE WHEN cp.id IS NOT NULL THEN true ELSE false END as is_custom
       FROM chapter_reviews r
       LEFT JOIN ai_profiles p ON r.ai_profile_id = p.id
       LEFT JOIN custom_reviewer_profiles cp ON r.custom_profile_id = cp.id
       WHERE r.chapter_id = $1
       ORDER BY r.created_at DESC`,
      [chapterId]
    );

    res.json(rows);
  } catch (error) {
    console.error("Get chapter reviews error:", error);
    res.status(500).json({ error: "Failed to get chapter reviews" });
  }
});

app.delete("/reviews/:id", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const reviewId = req.params.id;

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the chapter this review belongs to
    const { rows: reviewRows } = await pool.query(
      `SELECT r.id, b.user_id
       FROM chapter_reviews r
       JOIN chapters c ON r.chapter_id = c.id
       JOIN books b ON c.book_id = b.id
       WHERE r.id = $1`,
      [reviewId]
    );

    if (!reviewRows.length) {
      return res.status(404).json({ error: "Review not found" });
    }

    if (reviewRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to delete this review" });
    }

    await pool.query('DELETE FROM chapter_reviews WHERE id = $1', [reviewId]);

    res.json({ ok: true });
  } catch (error) {
    console.error("Delete review error:", error);
    res.status(500).json({ error: "Failed to delete review" });
  }
});

// Create a chapter-specific review with all prior summaries
app.post("/reviews", authenticateJWT, async (req: AuthenticatedRequest, res, next) => {
  try {
    console.log("Review request body:", JSON.stringify(req.body, null, 2));
    const { bookId, newChapterId, tone = "fanficnet", customProfileId } = ReviewReq.parse(req.body);

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the book
    const { rows: bookRows } = await pool.query(
      'SELECT user_id FROM books WHERE id = $1',
      [bookId]
    );

    if (!bookRows.length) {
      return res.status(404).json({ error: "Book not found" });
    }

    if (bookRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to access this book" });
    }

    const { rows: prior } = await pool.query(`
      SELECT c.id, c.title, s.summary
        FROM chapters c
        JOIN chapter_summaries s ON s.chapter_id=c.id
       WHERE c.book_id=$1 AND c.id <> $2
       ORDER BY c.id`, [bookId, newChapterId]);

    const { rows: targetRows } = await pool.query(`
      SELECT c.id, c.title, c.text
        FROM chapters c
       WHERE c.id=$1 AND c.book_id=$2`, [newChapterId, bookId]);
    if (!targetRows.length) return res.status(404).json({ error: "New chapter not found" });
    const target = targetRows[0];

    // Get AI profile - either custom profile or built-in tone
    let aiProfile;
    if (customProfileId) {
      // Using custom profile
      const { rows: customProfileRows } = await pool.query(
        `SELECT id, name, description
         FROM custom_reviewer_profiles
         WHERE id = $1 AND user_id = $2`,
        [customProfileId, dbUser.id]
      );
      if (!customProfileRows.length) {
        return res.status(404).json({ error: "Custom reviewer profile not found" });
      }
      // Use the description as the system prompt for custom profiles
      aiProfile = {
        id: `custom-${customProfileRows[0].id}`,
        system_prompt: `You are a beta reader with this personality and approach: ${customProfileRows[0].description}. Please review the following chapter providing feedback in this style.`
      };
    } else {
      // Using built-in tone
      const { rows: profileRows } = await pool.query(
        `SELECT id, system_prompt
         FROM ai_profiles
         WHERE (user_id = $1 OR is_system = true) AND tone_key = $2
         ORDER BY is_system ASC
         LIMIT 1`,
        [dbUser.id, tone]
      );

      if (!profileRows.length) {
        return res.status(404).json({ error: `AI profile not found for tone: ${tone}` });
      }

      aiProfile = profileRows[0];
    }
    const priorSummariesText = prior.map(r => `# ${r.id}${r.title ? ` — ${r.title}`:""}\n${r.summary}`).join("\n\n");

    const userPrompt = `PRIOR CHAPTER SUMMARIES:\n${priorSummariesText}\n\n` +
      `NEW CHAPTER: ${target.id}${target.title ? ` — ${target.title}` : ""}\n${target.text}\n\n` +
      "Write the review now.";

    // Store the full prompt for transparency
    const fullPrompt = `SYSTEM PROMPT:\n${aiProfile.system_prompt}\n\nUSER PROMPT:\n${userPrompt}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: aiProfile.system_prompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.7
    });

    const reviewText = response.choices[0]?.message?.content || "";

    // Save the review to the database
    if (customProfileId) {
      // Save custom profile review - first check if review exists
      const { rows: existingReview } = await pool.query(
        `SELECT id FROM chapter_reviews WHERE chapter_id = $1 AND custom_profile_id = $2`,
        [newChapterId, customProfileId]
      );

      if (existingReview.length > 0) {
        // Update existing review
        await pool.query(
          `UPDATE chapter_reviews SET review_text = $1, prompt_used = $2, updated_at = now() WHERE id = $3`,
          [reviewText, fullPrompt, existingReview[0].id]
        );
      } else {
        // Insert new review
        await pool.query(
          `INSERT INTO chapter_reviews (chapter_id, custom_profile_id, review_text, prompt_used) VALUES ($1, $2, $3, $4)`,
          [newChapterId, customProfileId, reviewText, fullPrompt]
        );
      }
    } else {
      // Save AI profile review - first check if review exists
      const { rows: existingReview } = await pool.query(
        `SELECT id FROM chapter_reviews WHERE chapter_id = $1 AND ai_profile_id = $2`,
        [newChapterId, aiProfile.id]
      );

      if (existingReview.length > 0) {
        // Update existing review
        await pool.query(
          `UPDATE chapter_reviews SET review_text = $1, prompt_used = $2, updated_at = now() WHERE id = $3`,
          [reviewText, fullPrompt, existingReview[0].id]
        );
      } else {
        // Insert new review
        await pool.query(
          `INSERT INTO chapter_reviews (chapter_id, ai_profile_id, review_text, prompt_used) VALUES ($1, $2, $3, $4)`,
          [newChapterId, aiProfile.id, reviewText, fullPrompt]
        );
      }
    }

    res.json({ ok: true, review: reviewText });
  } catch (e) { next(e); }
});

app.get("/books/:id/chapters", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the book
    const { rows: bookRows } = await pool.query(
      'SELECT user_id FROM books WHERE id = $1',
      [req.params.id]
    );

    if (!bookRows.length) {
      return res.status(404).json({ error: "Book not found" });
    }

    if (bookRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to access this book" });
    }

    const { rows } = await pool.query(`
      SELECT c.id, c.title, c.word_count, c.part_id,
             CASE WHEN s.chapter_id IS NULL THEN false ELSE true END AS has_summary,
             s.summary,
             p.name as part_name,
             array_position(b.chapter_order, c.id) as position,
             array_position(p.chapter_order, c.id) as position_in_part
        FROM chapters c
        LEFT JOIN chapter_summaries s ON s.chapter_id = c.id
        LEFT JOIN book_parts p ON c.part_id = p.id
        JOIN books b ON c.book_id = b.id
       WHERE c.book_id=$1
       ORDER BY array_position(b.chapter_order, c.id), c.id`, [req.params.id]);

    res.json(rows);
  } catch (error) {
    console.error("Get chapters error:", error);
    res.status(500).json({ error: "Failed to get chapters" });
  }
});

app.get("/chapters/:id", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    const { rows } = await pool.query(`
      SELECT c.id, c.book_id, c.title, c.text, c.word_count, c.updated_at,
             s.summary, s.pov, s.characters, s.beats, s.spoilers_ok, b.user_id
        FROM chapters c
        LEFT JOIN chapter_summaries s ON s.chapter_id=c.id
        JOIN books b ON c.book_id = b.id
       WHERE c.id=$1`, [req.params.id]);

    if (!rows.length) {
      return res.status(404).json({ error: "Chapter not found" });
    }

    const chapter = rows[0];

    // Verify user owns the book
    if (chapter.user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to access this chapter" });
    }

    // Remove user_id from response
    const { user_id, ...responseData } = chapter;
    res.json(responseData);
  } catch (error) {
    console.error("Get chapter error:", error);
    res.status(500).json({ error: "Failed to get chapter" });
  }
});

// ---- Character List routes
app.get("/books/:id/characters", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const bookId = req.params.id;

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the book
    const { rows: bookRows } = await pool.query(
      'SELECT user_id FROM books WHERE id = $1',
      [bookId]
    );

    if (!bookRows.length) {
      return res.status(404).json({ error: "Book not found" });
    }

    if (bookRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to access this book" });
    }

    // Get all characters for this book
    const { rows } = await pool.query(
      `SELECT bc.*, wp.page_name as wiki_page_name
       FROM book_characters bc
       LEFT JOIN wiki_pages wp ON bc.wiki_page_id = wp.id
       WHERE bc.book_id = $1
       ORDER BY bc.mention_count DESC, bc.character_name`,
      [bookId]
    );

    res.json(rows);
  } catch (error) {
    console.error("Get book characters error:", error);
    res.status(500).json({ error: "Failed to get book characters" });
  }
});

// ---- Wiki routes
app.get("/books/:id/wiki", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const bookId = req.params.id;

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the book
    const { rows: bookRows } = await pool.query(
      'SELECT user_id FROM books WHERE id = $1',
      [bookId]
    );

    if (!bookRows.length) {
      return res.status(404).json({ error: "Book not found" });
    }

    if (bookRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to access this book" });
    }

    // Get all wiki pages for this book
    const { rows } = await pool.query(
      `SELECT id, page_name, page_type, summary, aliases, tags, is_major,
              created_by_ai, created_at, updated_at,
              LENGTH(content) as content_length
       FROM wiki_pages
       WHERE book_id = $1
       ORDER BY is_major DESC, page_type, page_name`,
      [bookId]
    );

    res.json(rows);
  } catch (error) {
    console.error("Get wiki pages error:", error);
    res.status(500).json({ error: "Failed to get wiki pages" });
  }
});

app.get("/wiki/:id", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const wikiPageId = req.params.id;

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Get wiki page with book ownership verification
    const { rows } = await pool.query(
      `SELECT w.*, b.user_id
       FROM wiki_pages w
       JOIN books b ON w.book_id = b.id
       WHERE w.id = $1`,
      [wikiPageId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Wiki page not found" });
    }

    const wikiPage = rows[0];

    // Verify user owns the book
    if (wikiPage.user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to access this wiki page" });
    }

    // Remove user_id from response
    const { user_id, ...responseData } = wikiPage;
    res.json(responseData);
  } catch (error) {
    console.error("Get wiki page error:", error);
    res.status(500).json({ error: "Failed to get wiki page" });
  }
});

app.post("/books/:id/wiki", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const bookId = req.params.id;
    const data = CreateWikiPage.parse(req.body);

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the book
    const { rows: bookRows } = await pool.query(
      'SELECT user_id FROM books WHERE id = $1',
      [bookId]
    );

    if (!bookRows.length) {
      return res.status(404).json({ error: "Book not found" });
    }

    if (bookRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to access this book" });
    }

    // Create wiki page
    const { rows } = await pool.query(
      `INSERT INTO wiki_pages (book_id, page_name, page_type, content, summary, aliases, tags, is_major)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        bookId,
        data.page_name,
        data.page_type || 'character',
        data.content || '',
        data.summary || null,
        JSON.stringify(data.aliases || []),
        JSON.stringify(data.tags || []),
        data.is_major || false
      ]
    );

    res.json({ ok: true, page: rows[0] });
  } catch (error) {
    console.error("Create wiki page error:", error);
    res.status(500).json({ error: "Failed to create wiki page" });
  }
});

app.put("/wiki/:id", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const wikiPageId = req.params.id;
    const data = UpdateWikiPage.parse(req.body);

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the book and get current content for audit log
    const { rows: wikiRows } = await pool.query(
      `SELECT w.*, b.user_id
       FROM wiki_pages w
       JOIN books b ON w.book_id = b.id
       WHERE w.id = $1`,
      [wikiPageId]
    );

    if (!wikiRows.length) {
      return res.status(404).json({ error: "Wiki page not found" });
    }

    const currentPage = wikiRows[0];

    if (currentPage.user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to edit this wiki page" });
    }

    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (data.page_name !== undefined) {
      updates.push(`page_name = $${paramIndex++}`);
      values.push(data.page_name);
    }
    if (data.page_type !== undefined) {
      updates.push(`page_type = $${paramIndex++}`);
      values.push(data.page_type);
    }
    if (data.content !== undefined) {
      updates.push(`content = $${paramIndex++}`);
      values.push(data.content);
    }
    if (data.summary !== undefined) {
      updates.push(`summary = $${paramIndex++}`);
      values.push(data.summary);
    }
    if (data.aliases !== undefined) {
      updates.push(`aliases = $${paramIndex++}`);
      values.push(JSON.stringify(data.aliases));
    }
    if (data.tags !== undefined) {
      updates.push(`tags = $${paramIndex++}`);
      values.push(JSON.stringify(data.tags));
    }
    if (data.is_major !== undefined) {
      updates.push(`is_major = $${paramIndex++}`);
      values.push(data.is_major);
    }

    updates.push(`updated_at = now()`);
    values.push(wikiPageId);

    const { rows } = await pool.query(
      `UPDATE wiki_pages SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    // Log the update in wiki_updates table
    if (data.content !== undefined && data.content !== currentPage.content) {
      await pool.query(
        `INSERT INTO wiki_updates (wiki_page_id, update_type, previous_content, new_content, change_summary)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          wikiPageId,
          'manual_edit',
          currentPage.content,
          data.content,
          'Manual edit by user'
        ]
      );
    }

    res.json({ ok: true, page: rows[0] });
  } catch (error) {
    console.error("Update wiki page error:", error);
    res.status(500).json({ error: "Failed to update wiki page" });
  }
});

app.delete("/wiki/:id", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const wikiPageId = req.params.id;

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the book
    const { rows: wikiRows } = await pool.query(
      `SELECT w.id, b.user_id
       FROM wiki_pages w
       JOIN books b ON w.book_id = b.id
       WHERE w.id = $1`,
      [wikiPageId]
    );

    if (!wikiRows.length) {
      return res.status(404).json({ error: "Wiki page not found" });
    }

    if (wikiRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to delete this wiki page" });
    }

    await pool.query('DELETE FROM wiki_pages WHERE id = $1', [wikiPageId]);

    res.json({ ok: true });
  } catch (error) {
    console.error("Delete wiki page error:", error);
    res.status(500).json({ error: "Failed to delete wiki page" });
  }
});

app.get("/wiki/:id/history", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const wikiPageId = req.params.id;

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the book
    const { rows: wikiRows } = await pool.query(
      `SELECT w.id, b.user_id
       FROM wiki_pages w
       JOIN books b ON w.book_id = b.id
       WHERE w.id = $1`,
      [wikiPageId]
    );

    if (!wikiRows.length) {
      return res.status(404).json({ error: "Wiki page not found" });
    }

    if (wikiRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to access this wiki page" });
    }

    // Get update history
    const { rows } = await pool.query(
      `SELECT wu.*, c.title as chapter_title
       FROM wiki_updates wu
       LEFT JOIN chapters c ON wu.chapter_id = c.id
       WHERE wu.wiki_page_id = $1
       ORDER BY wu.created_at DESC`,
      [wikiPageId]
    );

    res.json(rows);
  } catch (error) {
    console.error("Get wiki history error:", error);
    res.status(500).json({ error: "Failed to get wiki history" });
  }
});

// basic error handler
app.use((err:any, _req:any, res:any, _next:any) => {
  console.error(err);
  res.status(500).json({ error: "Internal error", detail: String(err?.message || err) });
});

// Book Parts Management
app.get("/books/:bookId/parts", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the book
    const { rows: bookRows } = await pool.query(
      'SELECT user_id FROM books WHERE id = $1',
      [req.params.bookId]
    );

    if (!bookRows.length) {
      return res.status(404).json({ error: "Book not found" });
    }

    if (bookRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to access this book" });
    }

    const { rows } = await pool.query(
      'SELECT id, name, created_at FROM book_parts WHERE book_id = $1 ORDER BY created_at',
      [req.params.bookId]
    );

    res.json(rows);
  } catch (error) {
    console.error("Get parts error:", error);
    res.status(500).json({ error: "Failed to get parts" });
  }
});

app.post("/books/:bookId/parts", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const { name, position } = req.body;

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the book
    const { rows: bookRows } = await pool.query(
      'SELECT user_id FROM books WHERE id = $1',
      [req.params.bookId]
    );

    if (!bookRows.length) {
      return res.status(404).json({ error: "Book not found" });
    }

    if (bookRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to modify this book" });
    }

    const { rows } = await pool.query(
      'INSERT INTO book_parts (book_id, name) VALUES ($1, $2) RETURNING *',
      [req.params.bookId, name]
    );

    res.json(rows[0]);
  } catch (error) {
    console.error("Create part error:", error);
    res.status(500).json({ error: "Failed to create part" });
  }
});

app.put("/books/:bookId/parts/:partId", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const { name } = req.body;

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the book
    const { rows: bookRows } = await pool.query(
      'SELECT user_id FROM books WHERE id = $1',
      [req.params.bookId]
    );

    if (!bookRows.length) {
      return res.status(404).json({ error: "Book not found" });
    }

    if (bookRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to modify this book" });
    }

    if (!name) {
      return res.status(400).json({ error: "Name is required" });
    }

    const { rows } = await pool.query(
      `UPDATE book_parts SET name = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND book_id = $3
       RETURNING *`,
      [name, req.params.partId, req.params.bookId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Part not found" });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error("Update part error:", error);
    res.status(500).json({ error: "Failed to update part" });
  }
});

app.delete("/books/:bookId/parts/:partId", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the book
    const { rows: bookRows } = await pool.query(
      'SELECT user_id FROM books WHERE id = $1',
      [req.params.bookId]
    );

    if (!bookRows.length) {
      return res.status(404).json({ error: "Book not found" });
    }

    if (bookRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to modify this book" });
    }

    // Remove chapters from this part (set part_id to NULL)
    await pool.query(
      'UPDATE chapters SET part_id = NULL WHERE part_id = $1',
      [req.params.partId]
    );

    const { rows } = await pool.query(
      'DELETE FROM book_parts WHERE id = $1 AND book_id = $2 RETURNING id',
      [req.params.partId, req.params.bookId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Part not found" });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Delete part error:", error);
    res.status(500).json({ error: "Failed to delete part" });
  }
});

// Chapter Reordering
app.put("/chapters/:chapterId/reorder", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const { partId, bookPosition, partPosition } = req.body;
    // partId: which part to move to (null for uncategorized)
    // bookPosition: position in global book order (optional)
    // partPosition: position within the part (optional)

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Get chapter and verify ownership
    const { rows: chapterRows } = await pool.query(
      `SELECT c.id, c.book_id, c.part_id, b.user_id, b.chapter_order
       FROM chapters c
       JOIN books b ON c.book_id = b.id
       WHERE c.id = $1`,
      [req.params.chapterId]
    );

    if (!chapterRows.length) {
      return res.status(404).json({ error: "Chapter not found" });
    }

    const chapter = chapterRows[0];
    if (chapter.user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to modify this chapter" });
    }

    await withTx(async (client) => {
      // Update part assignment if specified
      if (partId !== undefined) {
        await client.query(
          'UPDATE chapters SET part_id = $1 WHERE id = $2',
          [partId === null ? null : partId, req.params.chapterId]
        );

        // Update part arrays
        if (chapter.part_id) {
          // Remove from old part
          await client.query(
            `UPDATE book_parts
             SET chapter_order = array_remove(chapter_order, $1)
             WHERE id = $2`,
            [req.params.chapterId, chapter.part_id]
          );
        }

        if (partId && partId !== null) {
          // Add to new part at specified position or end
          if (partPosition !== undefined) {
            // Insert at specific position
            await client.query(
              `UPDATE book_parts
               SET chapter_order = array_insert(chapter_order, $1, $2)
               WHERE id = $3`,
              [partPosition + 1, req.params.chapterId, partId] // PostgreSQL arrays are 1-indexed
            );
          } else {
            // Add to end
            await client.query(
              `UPDATE book_parts
               SET chapter_order = array_append(chapter_order, $1)
               WHERE id = $2`,
              [req.params.chapterId, partId]
            );
          }
        }
      }

      // Update book order if specified
      if (bookPosition !== undefined) {
        // Remove from current position and insert at new position
        let newOrder = chapter.chapter_order.filter(id => id !== req.params.chapterId);
        newOrder.splice(bookPosition, 0, req.params.chapterId);

        await client.query(
          'UPDATE books SET chapter_order = $1 WHERE id = $2',
          [newOrder, chapter.book_id]
        );
      }
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Reorder chapter error:", error);
    res.status(500).json({ error: "Failed to reorder chapter" });
  }
});

// Batch reorder chapters (for drag and drop)
app.put("/books/:bookId/chapters/reorder", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const { chapterOrder, partUpdates } = req.body;
    // chapterOrder: Array of chapter IDs in new book order
    // partUpdates: { [partId]: chapterIds[] } - chapters assigned to each part

    console.log('Backend received chapter reorder:', {
      bookOrder: chapterOrder?.length,
      partUpdates: Object.keys(partUpdates || {}).length
    });

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const dbUser = await getUserFromAuth0Sub(req.user.sub);
    if (!dbUser) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Verify user owns the book
    const { rows: bookRows } = await pool.query(
      'SELECT user_id FROM books WHERE id = $1',
      [req.params.bookId]
    );

    if (!bookRows.length) {
      return res.status(404).json({ error: "Book not found" });
    }

    if (bookRows[0].user_id !== dbUser.id) {
      return res.status(403).json({ error: "You don't have permission to modify this book" });
    }

    // Update arrays in a transaction - much simpler!
    await withTx(async (client) => {
      // Update book's global chapter order
      if (chapterOrder) {
        await client.query(
          'UPDATE books SET chapter_order = $1 WHERE id = $2',
          [chapterOrder, req.params.bookId]
        );
      }

      // Update part assignments for chapters
      if (partUpdates) {
        for (const [partId, chapterIds] of Object.entries(partUpdates)) {
          if (partId === 'null') {
            // Remove chapters from parts (set part_id to null)
            const chapterIdsArray = chapterIds as string[];
            if (chapterIdsArray.length > 0) {
              await client.query(
                `UPDATE chapters SET part_id = NULL
                 WHERE id = ANY($1) AND book_id = $2`,
                [chapterIdsArray, req.params.bookId]
              );
            }
          } else {
            // Update part's chapter order and assign chapters to part
            const chapterIdsArray = chapterIds as string[];
            await client.query(
              'UPDATE book_parts SET chapter_order = $1 WHERE id = $2',
              [chapterIdsArray, partId]
            );

            if (chapterIdsArray.length > 0) {
              await client.query(
                `UPDATE chapters SET part_id = $1
                 WHERE id = ANY($2) AND book_id = $3`,
                [partId, chapterIdsArray, req.params.bookId]
              );
            }
          }
        }
      }
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Batch reorder error:", error);
    res.status(500).json({ error: "Failed to reorder chapters" });
  }
});

// ---- Custom Reviewer Profiles Routes ----

// GET /custom-reviewer-profiles - Get user's custom reviewer profiles
app.get("/custom-reviewer-profiles", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const user = await getUserFromAuth0Sub(req.user!.sub);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const result = await pool.query(
      `SELECT id, name, description, created_at, updated_at
       FROM custom_reviewer_profiles
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [user.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Get custom reviewer profiles error:", error);
    res.status(500).json({ error: "Failed to get custom reviewer profiles" });
  }
});

// POST /custom-reviewer-profiles - Create a new custom reviewer profile
app.post("/custom-reviewer-profiles", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const body = CreateCustomReviewerProfile.parse(req.body);
    const user = await getUserFromAuth0Sub(req.user!.sub);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const result = await pool.query(
      `INSERT INTO custom_reviewer_profiles (user_id, name, description)
       VALUES ($1, $2, $3)
       RETURNING id, name, description, created_at, updated_at`,
      [user.id, body.name, body.description]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Create custom reviewer profile error:", error);
    if (error instanceof Error && error.message.includes('duplicate key')) {
      res.status(409).json({ error: "A profile with this name already exists" });
    } else {
      res.status(500).json({ error: "Failed to create custom reviewer profile" });
    }
  }
});

// PUT /custom-reviewer-profiles/:id - Update a custom reviewer profile
app.put("/custom-reviewer-profiles/:id", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const body = UpdateCustomReviewerProfile.parse(req.body);
    const user = await getUserFromAuth0Sub(req.user!.sub);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Verify ownership
    const ownershipCheck = await pool.query(
      `SELECT id FROM custom_reviewer_profiles WHERE id = $1 AND user_id = $2`,
      [req.params.id, user.id]
    );

    if (ownershipCheck.rows.length === 0) {
      return res.status(404).json({ error: "Custom reviewer profile not found" });
    }

    // Build update query dynamically
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (body.name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(body.name);
    }
    if (body.description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(body.description);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE custom_reviewer_profiles
       SET ${updates.join(', ')}
       WHERE id = $${paramCount}
       RETURNING id, name, description, created_at, updated_at`,
      values
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Update custom reviewer profile error:", error);
    if (error instanceof Error && error.message.includes('duplicate key')) {
      res.status(409).json({ error: "A profile with this name already exists" });
    } else {
      res.status(500).json({ error: "Failed to update custom reviewer profile" });
    }
  }
});

// DELETE /custom-reviewer-profiles/:id - Delete a custom reviewer profile
app.delete("/custom-reviewer-profiles/:id", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const user = await getUserFromAuth0Sub(req.user!.sub);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const result = await pool.query(
      `DELETE FROM custom_reviewer_profiles
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [req.params.id, user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Custom reviewer profile not found" });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Delete custom reviewer profile error:", error);
    res.status(500).json({ error: "Failed to delete custom reviewer profile" });
  }
});

// ---- Search endpoints
app.get("/books/:bookId/search", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const bookId = req.params.bookId;
    const query = req.query.q as string;

    if (!query || query.trim().length === 0) {
      return res.json({ chapters: [], wikiPages: [] });
    }

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const user = await getUserFromAuth0Sub(req.user.sub);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const searchTerm = `%${query.toLowerCase()}%`;

    // Search chapters
    const chapterResults = await pool.query(`
      SELECT c.id, c.title, c.text, c.word_count,
             array_position(b.chapter_order, c.id) as position
      FROM chapters c
      JOIN books b ON c.book_id = b.id
      WHERE b.id = $1 AND b.user_id = $2 AND LOWER(c.text) LIKE $3
      ORDER BY array_position(b.chapter_order, c.id)
    `, [bookId, user.id, searchTerm]);

    // Search wiki pages
    const wikiResults = await pool.query(`
      SELECT wp.id, wp.page_name, wp.content, wp.summary, wp.page_type
      FROM wiki_pages wp
      WHERE wp.book_id = $1 AND (
        LOWER(wp.content) LIKE $2 OR
        LOWER(wp.summary) LIKE $2 OR
        LOWER(wp.page_name) LIKE $2
      )
      ORDER BY wp.page_name
    `, [bookId, searchTerm]);

    res.json({
      chapters: chapterResults.rows,
      wikiPages: wikiResults.rows
    });
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ error: "Failed to search book" });
  }
});

app.post("/chapters/:chapterId/replace", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const chapterId = req.params.chapterId;
    const { searchTerm, replaceTerm } = req.body;

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const user = await getUserFromAuth0Sub(req.user.sub);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Verify ownership
    const chapter = await pool.query(`
      SELECT c.id, c.text, c.book_id
      FROM chapters c
      JOIN books b ON c.book_id = b.id
      WHERE c.id = $1 AND b.user_id = $2
    `, [chapterId, user.id]);

    if (chapter.rows.length === 0) {
      return res.status(404).json({ error: "Chapter not found" });
    }

    // Perform replacement
    const updatedText = chapter.rows[0].text.replace(new RegExp(escapeRegExp(searchTerm), 'gi'), replaceTerm);
    const wordCount = updatedText.split(/\s+/).filter(word => word.length > 0).length;

    await pool.query(`
      UPDATE chapters
      SET text = $1, word_count = $2, updated_at = NOW()
      WHERE id = $3
    `, [updatedText, wordCount, chapterId]);

    res.json({ success: true, updatedText, wordCount });
  } catch (error) {
    console.error("Replace in chapter error:", error);
    res.status(500).json({ error: "Failed to replace text in chapter" });
  }
});

app.post("/wiki/:wikiPageId/replace", authenticateJWT, async (req: AuthenticatedRequest, res) => {
  try {
    const wikiPageId = req.params.wikiPageId;
    const { searchTerm, replaceTerm } = req.body;

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const user = await getUserFromAuth0Sub(req.user.sub);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Verify ownership
    const wikiPage = await pool.query(`
      SELECT wp.id, wp.content, wp.summary, wp.page_name
      FROM wiki_pages wp
      JOIN books b ON wp.book_id = b.id
      WHERE wp.id = $1 AND b.user_id = $2
    `, [wikiPageId, user.id]);

    if (wikiPage.rows.length === 0) {
      return res.status(404).json({ error: "Wiki page not found" });
    }

    const page = wikiPage.rows[0];

    // Perform replacement in content, summary, and page name
    const updatedContent = page.content ? page.content.replace(new RegExp(escapeRegExp(searchTerm), 'gi'), replaceTerm) : page.content;
    const updatedSummary = page.summary ? page.summary.replace(new RegExp(escapeRegExp(searchTerm), 'gi'), replaceTerm) : page.summary;
    const updatedPageName = page.page_name.replace(new RegExp(escapeRegExp(searchTerm), 'gi'), replaceTerm);

    await pool.query(`
      UPDATE wiki_pages
      SET content = $1, summary = $2, page_name = $3, updated_at = NOW()
      WHERE id = $4
    `, [updatedContent, updatedSummary, updatedPageName, wikiPageId]);

    res.json({
      success: true,
      updatedContent,
      updatedSummary,
      updatedPageName
    });
  } catch (error) {
    console.error("Replace in wiki page error:", error);
    res.status(500).json({ error: "Failed to replace text in wiki page" });
  }
});

// Helper function to escape regex special characters
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

app.listen(process.env.PORT || 3001, () => {
  console.log(`AI Beta Reader API listening on http://localhost:${process.env.PORT || 3001}`);
});