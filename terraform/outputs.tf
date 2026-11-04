# These feed worker/wrangler.toml. After `terraform apply`, copy them in
# (bucket_name -> [[r2_buckets]].bucket_name, database_id -> [[d1_databases]].database_id).

output "bucket_name" {
  description = "R2 bucket name for wrangler.toml r2_buckets binding."
  value       = cloudflare_r2_bucket.videos.name
}

output "database_id" {
  description = "D1 database id for wrangler.toml d1_databases binding."
  value       = cloudflare_d1_database.metadata.id
}

output "database_name" {
  description = "D1 database name (for `wrangler d1 migrations apply`)."
  value       = cloudflare_d1_database.metadata.name
}

output "retention_days" {
  description = "Copy into wrangler.toml [vars] RETENTION_DAYS."
  value       = var.retention_days
}
