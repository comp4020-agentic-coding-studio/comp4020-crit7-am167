CREATE TABLE `bookings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`room_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`date` text NOT NULL,
	`start_slot` integer NOT NULL,
	`end_slot` integer NOT NULL,
	`purpose` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`cancelled_at` text,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bookings_room_date` ON `bookings` (`room_id`,`date`);--> statement-breakpoint
CREATE INDEX `bookings_user` ON `bookings` (`user_id`);--> statement-breakpoint
CREATE TABLE `buildings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`levels` integer NOT NULL,
	`rings` text NOT NULL,
	`plan` text NOT NULL,
	`centre_x` real NOT NULL,
	`centre_z` real NOT NULL,
	`radius` real NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `buildings_code` ON `buildings` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `buildings_slug` ON `buildings` (`slug`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`building_id` integer NOT NULL,
	`code` text NOT NULL,
	`floor` integer NOT NULL,
	`kind` text NOT NULL,
	`capacity` integer NOT NULL,
	`features` text NOT NULL,
	`cx` real NOT NULL,
	`cz` real NOT NULL,
	`w` real NOT NULL,
	`d` real NOT NULL,
	`angle` real NOT NULL,
	FOREIGN KEY (`building_id`) REFERENCES `buildings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_code` ON `rooms` (`code`);--> statement-breakpoint
CREATE INDEX `rooms_building_floor` ON `rooms` (`building_id`,`floor`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uni_id` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'student' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_uni_id` ON `users` (`uni_id`);