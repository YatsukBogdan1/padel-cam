variable "api_token" {
  description = "Cloudflare API token with R2 + D1 edit permissions. Set via TF_VAR_api_token or terraform.tfvars (never commit)."
  type        = string
  sensitive   = true
}

variable "account_id" {
  description = "Cloudflare account ID that owns the R2 bucket and D1 database."
  type        = string
}

variable "bucket_name" {
  description = "R2 bucket name for stored match videos."
  type        = string
  default     = "padel-cam-videos"
}

variable "database_name" {
  description = "D1 database name for recording + court metadata."
  type        = string
  default     = "padel-cam-db"
}

variable "location_hint" {
  description = "R2 primary location hint (e.g. weur, eeur, apac, wnam, enam). Put it near your courts."
  type        = string
  default     = "weur"
}

variable "retention_days" {
  description = "Days to keep an unpurchased recording before the Worker cron deletes it. Wired into the Worker as RETENTION_DAYS."
  type        = number
  default     = 14
}
