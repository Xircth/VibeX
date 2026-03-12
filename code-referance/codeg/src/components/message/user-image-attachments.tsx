"use client"

import Image from "next/image"
import type { UserImageDisplay } from "@/lib/adapters/ai-elements-adapter"

interface UserImageAttachmentsProps {
  images: UserImageDisplay[]
  className?: string
}

export function UserImageAttachments({
  images,
  className,
}: UserImageAttachmentsProps) {
  if (images.length === 0) return null

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-1.5">
        {images.map((image, index) => (
          <div
            key={`${image.uri ?? image.name}-${index}`}
            className="overflow-hidden rounded-md border border-border/70 bg-muted/30"
          >
            <Image
              src={`data:${image.mime_type};base64,${image.data}`}
              alt={image.name}
              width={56}
              height={56}
              unoptimized
              className="h-14 w-14 object-cover"
            />
          </div>
        ))}
      </div>
    </div>
  )
}
