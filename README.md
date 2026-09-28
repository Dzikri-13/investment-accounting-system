# Supabase setup — clean v1.3

1. Create the new Supabase project.
2. Open **SQL Editor → New Query**.
3. Paste the **entire `schema.sql`** from this folder and click **Run**.
4. Confirm these tables exist in Table Editor:
   - `securities`
   - `investment_transactions`
   - `dividends`
   - `journal_entries`
   - `fair_value_adjustments`
5. Open the project with VS Code and run `index.html` using Live Server.

The SQL is self-contained: no previous migration is required.

The browser uses the project's publishable key from `js/config.js`. The key is not a service-role key. This project is configured for classroom/demo use with public CRUD RLS policies; production use should add Supabase Auth and user/company-scoped policies.
