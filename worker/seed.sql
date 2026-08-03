-- VIBE Operations Tracker: seed data
-- Generated from vibe_dashboardDRAFT.html. Do not hand-edit; regenerate instead.
-- Run with: npx wrangler d1 execute vibe-tracker --file=./seed.sql --remote

-- WHERE is_system = 0: never wipe the automated-reminder system user (added
-- in schema.sql, not part of the draft-generated data below).
DELETE FROM task_notes; DELETE FROM task_owners; DELETE FROM tasks; DELETE FROM key_risks;
DELETE FROM project_owners; DELETE FROM projects; DELETE FROM settings; DELETE FROM users WHERE is_system = 0;

-- Users -------------------------------------------------------
INSERT INTO users (id,name,email,role,status) VALUES ('sam','Sam','sam@visionbrokers.co.za','admin','active');
INSERT INTO users (id,name,email,role,status) VALUES ('deoni','Deoni','deoni@visionric.co.za','admin','active');
INSERT INTO users (id,name,email,role,status) VALUES ('ferdi','Ferdi','ferdi@visionpw.co.za','admin','active');
INSERT INTO users (id,name,email,role,status) VALUES ('mia','Mia','mia@visionbrokers.co.za','member','active');
INSERT INTO users (id,name,email,role,status) VALUES ('stan','Stan','stanford@visionbrokers.co.za','member','active');
INSERT INTO users (id,name,email,role,status) VALUES ('elrine','Elrine','elrine@visionbrokers.co.za','member','active');
-- Idempotent: guarantees the system user exists even if seed.sql is ever run
-- standalone, without wiping/duplicating it if schema.sql already added it.
INSERT OR IGNORE INTO users (id,name,email,role,status,is_system)
  VALUES ('system','VIBE Tracker','system@vibe-tracker.local','member','active',1);

-- Settings ----------------------------------------------------
INSERT INTO settings (key,value,updated_by) VALUES ('focus_this_week','Fortress: finalise the distribution plan and start contacting pilot partners.','deoni');
INSERT INTO settings (key,value,updated_by) VALUES ('leadership_notes','["Fortress is priority one, and the most at risk of missing its own deadline. The distribution roll-out plan still needs finalising, and pilot partners still need to be contacted — that''s the actual gap between now and King Price''s end-Aug target.","Investors Club and VDirect are both fully built and sitting on sign-off, not more work. Neither needs further engineering — they need decisions and approvals to move.","VDirect''s delay isn''t ours. Discovery''s own compliance sign-off (~2 months) is the gate, independent of anything VIBE controls.","MRCN isn''t really a contract problem — it''s a data problem. The real priority is confirming whether the data we can actually get from Atwork and FSP is good enough to build a useful dashboard on. Exchanging contracts is procedural; building on weak data is the real risk."]','deoni');

-- 1. Fortress Africa -----------------------------------
INSERT INTO projects (id,num,name,status,target_text,target_date,summary,where_we_are,updated_by) VALUES ('fortress',1,'Fortress Africa','at-risk','Target: end Aug 2026 (King Price)','2026-08-31','Vision Group''s cyber insurance product: commercial and personal cyber cover, underwritten by King Price, administered by Alivio, distributed by Vision Brokers through a network of ICT/MSP referral partners who each get a tracked link and earn a recurring referral fee.','Product itself is near complete. Briisk is building the client onboarding, policy admin, payments and claims dashboard. What''s not built yet is the partner-facing layer: unique referral links, accreditation, and getting real partners signed and active in time for King Price''s target.','deoni');
INSERT INTO project_owners (project_id,user_id) VALUES ('fortress','deoni');
INSERT INTO project_owners (project_id,user_id) VALUES ('fortress','elrine');
INSERT INTO project_owners (project_id,user_id) VALUES ('fortress','sam');
INSERT INTO project_owners (project_id,user_id) VALUES ('fortress','ferdi');
INSERT INTO key_risks (project_id,body,sort_order) VALUES ('fortress','Distribution execution / outreach strategy not yet written',0);
INSERT INTO key_risks (project_id,body,sort_order) VALUES ('fortress','0 of 15 pilot partners actually contacted',1);
INSERT INTO key_risks (project_id,body,sort_order) VALUES ('fortress','Marketing / client-facing material still needs a design owner',2);
INSERT INTO key_risks (project_id,body,sort_order) VALUES ('fortress','Link export format to Briisk not yet confirmed',3);
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (1,'fortress','Write distribution / partner outreach execution plan','not-started',NULL,'',NULL,0,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (1,'deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (2,'fortress','Contact pilot partners (0/15 so far)','not-started',NULL,'',NULL,1,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (2,'elrine');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (3,'fortress','Define accreditation questions + compliance sign-off','not-started',NULL,'in-house QC, not FAIS-blocking',NULL,2,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (3,'elrine');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (3,'in-house QC, not FAIS-blocking',0,'deoni','deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (4,'fortress','Partner referral link build on Fortress site','in-progress',NULL,'pending Briisk export format confirmation',NULL,3,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (4,'sam');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (4,'pending Briisk export format confirmation',0,'deoni','deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (5,'fortress','Load partner agreement + compliance docs to site','not-started',NULL,'placeholders already built',NULL,4,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (5,'sam');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (5,'placeholders already built',0,'deoni','deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (6,'fortress','Design client/partner-facing marketing material','not-started',NULL,'Mia candidate','Unassigned',5,'deoni');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (6,'Mia candidate',0,'deoni','deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (7,'fortress','Social media pages + content','not-started',NULL,'Deoni leads + schedules, Mia creates content',NULL,6,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (7,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (7,'mia');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (7,'Deoni leads + schedules, Mia creates content',0,'deoni','deoni');

-- 2. Investors Club (VPIC) -----------------------------
INSERT INTO projects (id,num,name,status,target_text,target_date,summary,where_we_are,updated_by) VALUES ('vpic',2,'Investors Club (VPIC)','blocked','No hard deadline — sign-off dependent',NULL,'Ferdi-fronted property lead-generation brand. The site and its social media presence exist to drive prospects to opt in and give POPIA consent for direct marketing.','Build is feature-complete and the data pipeline is live and verified. Nothing left to engineer — everything outstanding is a sign-off, a decision, or a piece of content waiting on someone.','deoni');
INSERT INTO project_owners (project_id,user_id) VALUES ('vpic','sam');
INSERT INTO project_owners (project_id,user_id) VALUES ('vpic','deoni');
INSERT INTO project_owners (project_id,user_id) VALUES ('vpic','mia');
INSERT INTO project_owners (project_id,user_id) VALUES ('vpic','ferdi');
INSERT INTO key_risks (project_id,body,sort_order) VALUES ('vpic','Logo/social design blocked on red-V trademark decision',0);
INSERT INTO key_risks (project_id,body,sort_order) VALUES ('vpic','Legal sign-off on "not an agent/advisor" framing has no owner (needs PPRA/estate-agency counsel, not FAIS)',1);
INSERT INTO key_risks (project_id,body,sort_order) VALUES ('vpic','Several Sam/ops items open: domain registration, account migration off personal ownership, nurture sequence',2);
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (8,'vpic','Sign off calculator verdict copy (9 combinations)','not-started',NULL,'',NULL,0,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (8,'ferdi');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (9,'vpic','Supply real portrait photo','not-started',NULL,'no AI-generated face policy',NULL,1,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (9,'ferdi');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (9,'no AI-generated face policy',0,'deoni','deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (10,'vpic','Legal sign-off: agent/advisor framing','not-started',NULL,'needs PPRA-qualified counsel','Unassigned',2,'deoni');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (10,'needs PPRA-qualified counsel',0,'deoni','deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (11,'vpic','Marketing consent + Privacy Notice wording','not-started',NULL,'POPIA s69 opt-in','Legal',3,'deoni');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (11,'POPIA s69 opt-in',0,'deoni','deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (12,'vpic','Reconcile emerald green hex across social','not-started',NULL,'',NULL,4,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (12,'deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (13,'vpic','Fill privacy page placeholders (entity, email)','not-started',NULL,'',NULL,5,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (13,'sam');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (14,'vpic','Register domain','not-started',NULL,'',NULL,6,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (14,'sam');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (15,'vpic','Migrate GitHub / Vercel / Sheet to org accounts','not-started',NULL,'',NULL,7,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (15,'sam');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (16,'vpic','Build nurture email sequence','not-started',NULL,'',NULL,8,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (16,'sam');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (17,'vpic','FB profile pic + banner','blocked',NULL,'blocked on V-logo trademark decision',NULL,9,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (17,'deoni');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (17,'blocked on V-logo trademark decision',0,'deoni','deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (18,'vpic','Sign off social content calendar','not-started',NULL,'Mia already built calendar + ideas',NULL,10,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (18,'deoni');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (18,'Mia already built calendar + ideas',0,'deoni','deoni');

-- 3. Marketing Dashboard (MRCN) ------------------------
INSERT INTO projects (id,num,name,status,target_text,target_date,summary,where_we_are,updated_by) VALUES ('mrcn',3,'Marketing Dashboard (MRCN)','at-risk','MRCN build: 4-6 weeks once started',NULL,'MRCN (a Briisk sub-company) is building Vision a customised dashboard consolidating clients from every Vision company''s CRM into one database, for segmentation and cross-sell campaigns across the group.','Verbal agreement between Ferdi and MRCN in place, written contract pending. Sam is scoping (not sharing) what data can safely move from Atwork and FSP, since neither system offers API access, meaning this will be a static upload rather than a live feed.','deoni');
INSERT INTO project_owners (project_id,user_id) VALUES ('mrcn','sam');
INSERT INTO project_owners (project_id,user_id) VALUES ('mrcn','deoni');
INSERT INTO project_owners (project_id,user_id) VALUES ('mrcn','mia');
INSERT INTO project_owners (project_id,user_id) VALUES ('mrcn','ferdi');
INSERT INTO key_risks (project_id,body,sort_order) VALUES ('mrcn','Whether the Atwork/FSP data is actually good enough to build real value on — the bigger risk than the contract itself',0);
INSERT INTO key_risks (project_id,body,sort_order) VALUES ('mrcn','Written contract not yet signed — no client data may move until it is',1);
INSERT INTO key_risks (project_id,body,sort_order) VALUES ('mrcn','Refresh / re-upload cadence for the static CRM data still undefined',2);
INSERT INTO key_risks (project_id,body,sort_order) VALUES ('mrcn','Campaign strategy work only starts once the dashboard is built',3);
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (19,'mrcn','Assess if Atwork/FSP data is strong enough to justify the dashboard','not-started',NULL,'top priority — a dashboard built on weak data has no real scope',NULL,0,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (19,'deoni');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (19,'top priority — a dashboard built on weak data has no real scope',0,'deoni','deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (20,'mrcn','Finalise written contract with MRCN','not-started',NULL,'verbal agreement only so far',NULL,1,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (20,'ferdi');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (20,'verbal agreement only so far',0,'deoni','deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (21,'mrcn','Scope safe data-sharing method with Atwork + FSP','in-progress',NULL,'no data shared yet — gated on contract',NULL,2,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (21,'sam');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (21,'no data shared yet — gated on contract',0,'deoni','deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (22,'mrcn','Confirm refresh / re-upload cadence with MRCN','not-started',NULL,'static upload, not live feed',NULL,3,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (22,'deoni');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (22,'static upload, not live feed',0,'deoni','deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (23,'mrcn','Plan segmentation + campaign strategy (post-build)','not-started',NULL,'',NULL,4,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (23,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (23,'mia');

-- 4. VIB Website Rebuild -------------------------------
INSERT INTO projects (id,num,name,status,target_text,target_date,summary,where_we_are,updated_by) VALUES ('vib',4,'VIB Website Rebuild','at-risk','No deadline set yet',NULL,'Vision Brokers'' main site, covering Risk & Investment, Wealth, Health and Short-Term. Current site has outdated design, dead links, and missing compliance content (licences, disclaimers).','Decision in principle is a fresh rebuild rather than patching the existing WordPress site, given the missing content and dead links suggest the underlying structure is stale too, not just the look. Stan has content and stock images ready. Sits in his normal Vision IT hours, not his VIBE hour.','deoni');
INSERT INTO project_owners (project_id,user_id) VALUES ('vib','stan');
INSERT INTO key_risks (project_id,body,sort_order) VALUES ('vib','No confirmed deadline yet',0);
INSERT INTO key_risks (project_id,body,sort_order) VALUES ('vib','Rebuild-vs-modify decision should be validated with a quick timeboxed test before committing fully',1);
INSERT INTO key_risks (project_id,body,sort_order) VALUES ('vib','VRES (SA) site is a separate, parked item: currently outsourced to Propcon, in-house takeover flagged by the VRES team but no action yet',2);
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (24,'vib','Timebox modify-vs-rebuild test on weakest page (2-3hrs)','not-started',NULL,'confirms rebuild is the right call before committing',NULL,0,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (24,'stan');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (24,'confirms rebuild is the right call before committing',0,'deoni','deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (25,'vib','Full site rebuild','not-started',NULL,'content/images already available',NULL,1,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (25,'stan');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (25,'content/images already available',0,'deoni','deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (26,'vib','Upload missing licences + disclaimers','not-started',NULL,'',NULL,2,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (26,'stan');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (27,'vib','VRES (SA): evaluate in-house takeover from Propcon','paused',NULL,'flagged by VRES team, no action yet — separate from VIB',NULL,3,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (27,'deoni');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (27,'flagged by VRES team, no action yet — separate from VIB',0,'deoni','deoni');

-- 5. Vision Direct (VDirect) ---------------------------
INSERT INTO projects (id,num,name,status,target_text,target_date,summary,where_we_are,updated_by) VALUES ('vdirect',5,'Vision Direct (VDirect)','at-risk','Gated externally by Discovery, ~2 months','2026-09-27','Discovery tied-agent lead-generation site for Short-Term Personal Lines (car and home), presented across all six Discovery product lines. Positioned as the human filter on Discovery''s complexity.','Site is well-built and mostly finished. Remaining build work is the lead-capture function: client submits details, form emails them to a single VDirect agent, POPIA consent included at sign-up. After Sam finishes design, it goes to in-house KI compliance sign-off, then to Discovery for their own sign-off.','deoni');
INSERT INTO project_owners (project_id,user_id) VALUES ('vdirect','sam');
INSERT INTO project_owners (project_id,user_id) VALUES ('vdirect','elrine');
INSERT INTO key_risks (project_id,body,sort_order) VALUES ('vdirect','Discovery''s own compliance sign-off is expected to take ~2 months — this is the real bottleneck, external to VIBE',0);
INSERT INTO key_risks (project_id,body,sort_order) VALUES ('vdirect','In-house VRIC KI sign-off should be quick once design is done',1);
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (28,'vdirect','Finalise remaining design','in-progress',NULL,'',NULL,0,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (28,'sam');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (29,'vdirect','Build lead capture → email-to-agent function','in-progress',NULL,'POPIA consent included, single-agent routing',NULL,1,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (29,'sam');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (29,'POPIA consent included, single-agent routing',0,'deoni','deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (30,'vdirect','VRIC KI compliance sign-off','not-started',NULL,'in-house, fast turnaround',NULL,2,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (30,'elrine');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (30,'in-house, fast turnaround',0,'deoni','deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (31,'vdirect','Discovery compliance sign-off','not-started',NULL,'~2 month turnaround, external gate','External (Discovery)',3,'deoni');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (31,'~2 month turnaround, external gate',0,'deoni','deoni');

-- 6. VRES Namibia --------------------------------------
INSERT INTO projects (id,num,name,status,target_text,target_date,summary,where_we_are,updated_by) VALUES ('namibia',6,'VRES Namibia','blocked','No deadline set',NULL,'New Namibian branch of Vision Real Estate Specialists. Namibian authorities (BIPA) rejected the original name over conflict with an existing local business, requiring a new name, domain, company registration and website.','"V Real Estate Specialist" has been pre-checked clear at BIPA. Company registration (CC1) can''t be lodged until Accounting Officer and member/percentage details are confirmed internally. Domain registration is deliberately being held until CC1 completes, to register at local (not foreign) pricing.','deoni');
INSERT INTO project_owners (project_id,user_id) VALUES ('namibia','deoni');
INSERT INTO project_owners (project_id,user_id) VALUES ('namibia','ferdi');
INSERT INTO key_risks (project_id,body,sort_order) VALUES ('namibia','CC1 blocked on internal decision: who is Accounting Officer, and member/percentage split',0);
INSERT INTO key_risks (project_id,body,sort_order) VALUES ('namibia','CC8 formal name reservation needs confirming as fully lodged and approved, not just pre-checked',1);
INSERT INTO key_risks (project_id,body,sort_order) VALUES ('namibia','Red-V trademark not yet actioned — needs IP counsel (same search covers Investors Club''s logo trademark too)',2);
INSERT INTO key_risks (project_id,body,sort_order) VALUES ('namibia','Website scope (new build vs re-skin of existing VRES site) not yet decided',3);
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (32,'namibia','Confirm CC8 name reservation fully lodged + approved','not-started',NULL,'"V Real Estate Specialist" pre-checked clear at BIPA',NULL,0,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (32,'deoni');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (32,'"V Real Estate Specialist" pre-checked clear at BIPA',0,'deoni','deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (33,'namibia','Lodge CC1 founding statement','blocked',NULL,'',NULL,1,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (33,'deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (34,'namibia','Source IP counsel — red V trademark (SA + Namibia)','not-started',NULL,'covers Namibia naming + VPIC logo, multi-class filing',NULL,2,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (34,'ferdi');
INSERT INTO task_notes (task_id,body,sort_order,created_by,updated_by) VALUES (34,'covers Namibia naming + VPIC logo, multi-class filing',0,'deoni','deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (35,'namibia','Register domain as Local entity (post-CC1)','not-started',NULL,'',NULL,3,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (35,'deoni');
INSERT INTO tasks (id,project_id,name,status,due_date,note,owner_label,sort_order,updated_by) VALUES (36,'namibia','Confirm website scope: new build vs re-skin','not-started',NULL,'',NULL,4,'deoni');
INSERT INTO task_owners (task_id,user_id) VALUES (36,'deoni');
