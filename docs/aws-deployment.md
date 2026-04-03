# NebulaCloud Drive AWS Deployment Blueprint

This guide maps the current NebulaCloud Drive stack to AWS services using your required list.

## 1) Target Architecture (using your required services)

### Basic services
- **Amazon S3 (Storage):** Store uploaded file binaries and frontend static assets.
- **Amazon EC2 (Compute):** Run Node.js/Express backend API.
- **IAM (Security):** Least-privilege roles/policies for EC2, Lambda, and deployment users.
- **VPC (Network):** Public subnets for ALB, private subnets for EC2/RDS.
- **Amazon RDS (Database):** Replace `backend/data.json` metadata store with PostgreSQL/MySQL.

### Advanced services (use at least two)
- **Application Load Balancer (ALB):** HTTPS ingress and health-checked routing to EC2.
- **CloudFront:** CDN in front of ALB/S3 for lower latency.
- **CloudWatch:** Logs, dashboards, alarms.
- **Auto Scaling:** Scale EC2 instances based on CPU/request count.
- **Lambda:** Scheduled trash-purge and async tasks.

Optional additions from your list:
- **Elastic Beanstalk:** Alternative to manually managing EC2 + ALB + scaling.
- **EBS:** Root/data volumes for EC2 instances (API runtime only, not primary file storage).

---

## 2) Service mapping from current app

Current implementation:
- Backend API: `backend/server.js`
- Upload endpoint: `POST /api/upload`
- Download endpoint: `GET /api/files/:id/download`
- Metadata currently in `backend/data.json`
- File blobs currently under local `uploads/`

AWS mapping:
- Move `uploads/` binaries -> **S3 bucket**
- Move `data.json` metadata -> **RDS** tables (`users`, `files`, `shares`, `sessions`)
- Keep Express API on **EC2** behind **ALB**
- Serve static web assets via **CloudFront** (+ optionally S3 origin)
- Schedule 15-day trash cleanup with **EventBridge + Lambda**

---

## 3) Recommended resource layout

## VPC
- 2 AZs minimum
- Public subnets: ALB
- Private app subnets: EC2 Auto Scaling Group
- Private DB subnets: RDS Multi-AZ
- NAT Gateway for outbound updates from private subnets

## Security groups
- ALB SG: allow 80/443 from internet
- EC2 SG: allow 3000 only from ALB SG
- RDS SG: allow DB port only from EC2 SG

## IAM
- EC2 instance profile policy:
  - `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` for only your app bucket path
  - `logs:CreateLogStream`, `logs:PutLogEvents`
- Lambda execution role:
  - Access to app bucket + DB secret read + CloudWatch logs

---

## 4) S3 strategy

Create buckets:
- `nebula-drive-assets-<env>` (frontend files)
- `nebula-drive-files-<env>` (user uploads)

Best practices:
- Enable versioning and server-side encryption (SSE-S3 or SSE-KMS)
- Block public access on files bucket
- Use lifecycle transitions if needed (e.g., Standard -> IA)

Upload/download flow:
1. Client asks API for pre-signed URL (PUT for upload, GET for download).
2. Client uploads/downloads directly to/from S3.
3. API stores metadata in RDS.

---

## 5) RDS schema starter

Suggested tables:
- `users(id, email, password_hash, created_at)`
- `files(id, owner_id, path, type, size, s3_key, trashed_at, created_at, updated_at)`
- `shares(id, file_id, shared_with_user_id, created_at)`
- `sessions(id, user_id, token_hash, expires_at)` (or move to JWT + revocation table)

---

## 6) Compute and deployment

## EC2 bootstrap
- Install Node.js LTS
- Pull repo
- `npm ci`
- Run with PM2/systemd
- Put backend behind ALB target group

## SSL
- Use ACM certificate on ALB (HTTPS)
- Force HTTP -> HTTPS redirect

## Auto Scaling
- Min 2, desired 2, max based on expected load
- Policies on CPU and ALB request count

---

## 7) CloudWatch + operations

Create:
- Log groups for API and Lambda
- Alarms:
  - ALB 5XX > threshold
  - EC2 CPU high
  - RDS CPU/storage/connections
  - App error count spikes

---

## 8) Lambda workloads

Implement at least these:
1. **Trash retention cleanup** (daily): remove files older than 15 days from S3 + DB.
2. **Post-upload processor** (optional): metadata enrichment, virus scan trigger, thumbnails.

Trigger options:
- EventBridge schedule (cleanup)
- S3 event notifications (post-upload)

---

## 9) CloudFront

Distribute:
- Static frontend from S3 origin
- API via ALB origin (path-based routing `/api/*`)

Set cache policies:
- Aggressive cache for JS/CSS/images
- No cache for authenticated API paths

---

## 10) Migration checklist from current repo

1. Replace local file writes in `backend/server.js` with S3 SDK operations.
2. Replace JSON file DB with RDS queries.
3. Move auth from in-memory sessions to durable storage/JWT.
4. Add environment variables:
   - `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
   - `AWS_REGION`, `S3_FILES_BUCKET`, `S3_ASSETS_BUCKET`
   - `APP_ORIGIN`, `PORT`
5. Add CI/CD (GitHub Actions -> CodeDeploy/SSM/Beanstalk).

---

## 11) Minimum services used from your required list

Used basic:
- S3, EC2, IAM, VPC, RDS

Used advanced:
- ALB, CloudFront, CloudWatch, Auto Scaling, Lambda

(You can also use Elastic Beanstalk instead of hand-managed EC2 stack if you prefer.)


---

## 12) Step-by-step deployment runbook

1. **Create VPC and subnets** (2 AZ minimum): public for ALB, private for EC2/RDS.
2. **Create IAM roles**: EC2 role (S3 + CloudWatch), Lambda role (S3 + logs + DB secret read).
3. **Create RDS instance** in private subnets and initialize schema (`users`, `files`, `shares`, `sessions`).
4. **Create S3 buckets**: one for uploads, one for static frontend assets.
5. **Launch EC2 Auto Scaling Group** with Node.js runtime and app deploy script.
6. **Configure ALB** with target group health checks for your API (`/api/auth/me` or `/health`).
7. **Attach ACM certificate** and enforce HTTPS.
8. **Deploy backend** (`npm ci && npm start`) and set environment variables (`DB_*`, `S3_*`, `AWS_REGION`).
9. **Deploy frontend** to S3 assets bucket and place CloudFront in front of S3 + ALB origins.
10. **Create Lambda cleanup job** with EventBridge schedule for trash purge (daily).
11. **Enable CloudWatch alarms** for ALB 5xx, EC2 CPU, RDS CPU/storage/connections.
12. **Run smoke tests**: signup/signin, upload folder, share, trash/restore/delete, download, quota errors.
